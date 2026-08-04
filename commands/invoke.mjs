/**
 * Unified agent invocation — used by:
 *  1. Human slash commands (/odin-feature, /pr-gate, …)
 *  2. Workflow engine (automatic pipeline)
 *  3. Triggers (issue webhook, schedule, PR comment, gate failure)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, loadRegistry } from '../agents/registry.mjs';
import { buildAgentPrompt } from './build-prompt.mjs';
import { runLlm, providerDidNotRun } from '../llm/router.mjs';
import { bootstrapWorktree } from '../runtime/worktree.mjs';
import { STATE_DIR, FINDINGS_FILE, findingsFileFor, PLAN_FILE } from '../runtime/paths.mjs';
import { ghJson } from '../runtime/github.mjs';

/**
 * Did this invocation succeed?
 *
 * For a hard gate, `ok` means the gate PASSED — not that the process exited 0.
 * Callers outside the workflow graph read `ok` and nothing else: the CLI's exit
 * code, the gate-failure trigger, the PR-comment handler. A BLOCK reporting
 * ok:true reads as success to every one of them, and `--provider none` exits 0
 * by construction.
 *
 * Reported, never thrown: the engine routes BLOCK to `fixer`, and an exception
 * would land in runPipeline's catch as `status: 'error'`, ending the very fix
 * loop that exists to handle it.
 *
 * @param {{hard_gate?: boolean}} agent
 * @param {{verdict?: string}|null} verdict
 * @param {{status: number|null, skipped?: boolean}} result
 */
export function invocationOk(agent, verdict, result) {
  if (!agent.hard_gate) return result.status === 0 || !!result.skipped;
  return verdict?.verdict === 'SHIP' || verdict?.verdict === 'SHIP-AFTER';
}

/**
 * @param {string} commandName e.g. 'odin-feature' | 'pr-gate'
 * @param {object} opts
 */
export async function invokeCommand(commandName, opts = {}) {
  const agent = getAgent(commandName);
  if (agent.isPipeline) {
    const { runPipeline } = await import('../workflows/pipeline.mjs');
    return runPipeline(opts);
  }

  const reg = loadRegistry();
  const maxTurns = opts.maxTurns ?? reg.defaults?.max_turns ?? 100;
  const source = opts.source || 'human';

  let issue = null;
  if (typeof opts.issue === 'number') {
    try {
      issue = ghJson(['issue', 'view', String(opts.issue), '--json', 'number,title,body,labels']);
    } catch {
      issue = { number: opts.issue, title: `#${opts.issue}`, body: '' };
    }
  } else if (opts.issue && typeof opts.issue === 'object') {
    issue = opts.issue;
  }

  let wt = opts.cwd || null;
  let branch = opts.branch || null;
  let env = opts.env || {};

  // Human interactive: stay in cwd unless --worktree.
  // System/workflow: isolate when agent.isolation === worktree.
  const wantWt =
    opts.worktree === true ||
    (opts.worktree !== false && agent.isolation === 'worktree' && source !== 'human');

  if (wantWt && issue) {
    const boot = bootstrapWorktree(issue.number);
    wt = boot.wt;
    branch = boot.branch;
    env = { ...env, ...boot.env };
  }
  if (!wt) wt = process.cwd();

  const preferAlt = agent.prefer_alt_provider && reg.dual_review?.enabled;
  const providerName = opts.provider || process.env.AGENT_PROVIDER || agent.provider || 'auto';
  const avoid = preferAlt && opts.implementProvider ? opts.implementProvider : undefined;

  // The plan travels with the worktree, so every later agent in the run sees the
  // acceptance criteria planner decomposed the issue into. Read from disk rather
  // than only from the caller: a resumed run has the file and not the state.
  const planPath = join(wt, PLAN_FILE);
  let plan = opts.plan || null;
  if (!plan && existsSync(planPath)) {
    try {
      plan = JSON.parse(readFileSync(planPath, 'utf8'));
    } catch {
      // A malformed plan is context, not a gate — proceed without it.
      plan = null;
    }
  }

  // ONE path, used by the prompt, the pre-run cleanup and the read-back. They
  // were derived separately: the prompt honoured opts.findingsPath while the
  // other two used the default, so a caller passing a path would have had the
  // gate write to one file and the aggregator read another — reported as "no
  // verdict", or worse, silently answered by a stale file at the default.
  const findingsPath = opts.findingsPath ?? join(wt, findingsFileFor(agent.name));
  // The unsuffixed name is still read, so a worktree written before the naming
  // was settled is not orphaned. Both are cleared before a hard gate, or a
  // stale legacy file could answer for this round.
  const legacyFindingsPath = join(wt, FINDINGS_FILE);

  const prompt = buildAgentPrompt(agent, {
    issue,
    wt,
    branch,
    env,
    plan,
    planPath,
    extra: opts.extra,
    gateLog: opts.gateLog,
    // A hard gate reports its verdict through a file. Telling it the absolute
    // path here, rather than trusting the playbook to mention one, is what makes
    // the contract survive a playbook edit — pr-gate shipped for a week writing
    // only a text report, so every run ended "produced no verdict" and the
    // pipeline could never reach a PR.
    findingsPath: agent.hard_gate ? findingsPath : undefined,
    args: opts.args,
    flags: opts.flags,
  });

  mkdirSync(STATE_DIR, { recursive: true });
  const audit = {
    ts: new Date().toISOString(),
    command: commandName,
    agent: agent.name,
    source,
    issue: issue?.number ?? null,
    wt,
    branch,
    provider: providerName,
  };
  writeFileSync(join(STATE_DIR, `invoke-${Date.now()}.json`), JSON.stringify(audit, null, 2));

  if (opts.dryRun) {
    writeFileSync(join(wt, '.agent-prompt.txt'), prompt);
    return { ok: true, dryRun: true, promptPath: join(wt, '.agent-prompt.txt'), ...audit };
  }

  // A hard gate reads its verdict from a file the agent writes. A file left by
  // the previous fixer round would be read as THIS round's verdict, so the loop
  // could exit on a stale SHIP. Delete before, and only trust what reappears.
  if (agent.hard_gate) {
    rmSync(findingsPath, { force: true });
    rmSync(legacyFindingsPath, { force: true });
  }

  const result = runLlm(prompt, {
    cwd: wt,
    maxTurns,
    env,
    provider: providerName,
    avoid,
  });

  let verdict = null;
  let verdictError = null;
  const writtenTo = [findingsPath, legacyFindingsPath].find(existsSync);
  if (agent.hard_gate && writtenTo) {
    try {
      const { aggregate } = await import('../runtime/gates/aggregate-verdict.mjs');
      const report = JSON.parse(readFileSync(writtenTo, 'utf8'));
      const reports = Array.isArray(report) ? report : [report];
      verdict = aggregate(reports, {
        gateRed: opts.gateRed === true,
        gateUnrun: opts.gateUnrun === true,
      });
    } catch (e) {
      // An unreadable findings file is not "no findings" — say so, and leave
      // verdict null so the caller fails closed rather than reading it as clean.
      verdictError = `unreadable ${writtenTo}: ${e.message}`;
    }
  }

  // Re-read after the run: planner writes the plan, and anything downstream may
  // legitimately refine it (a task turning out to be already done, say).
  let planOut = plan;
  if (existsSync(planPath)) {
    try {
      planOut = JSON.parse(readFileSync(planPath, 'utf8'));
    } catch {
      planOut = plan;
    }
  }

  return {
    ok: invocationOk(agent, verdict, result),
    status: result.status,
    skipped: !!result.skipped,
    provider: result.provider,
    verdict,
    verdictError,
    // Carried so the caller can tell "the agent tried and failed" from "the
    // provider never started" — a distinction the fixer budget depends on.
    durationMs: result.durationMs,
    didNotRun: providerDidNotRun(result),
    findingsPath: writtenTo ?? findingsPath,
    plan: planOut,
    planPath,
    wt,
    branch,
    env,
    agent: agent.name,
    source,
  };
}
