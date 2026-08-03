/**
 * Unified agent invocation — used by:
 *  1. Human slash commands (/odin-feature, /pr-gate, …)
 *  2. Workflow engine (automatic pipeline)
 *  3. Triggers (issue webhook, schedule, PR comment, gate failure)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgent, loadRegistry } from '../agents/registry.mjs';
import { buildAgentPrompt } from './build-prompt.mjs';
import { runLlm } from '../llm/router.mjs';
import { bootstrapWorktree } from '../runtime/worktree.mjs';
import { STATE_DIR } from '../runtime/paths.mjs';
import { ghJson } from '../runtime/github.mjs';

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

  const prompt = buildAgentPrompt(agent, {
    issue,
    wt,
    branch,
    env,
    extra: opts.extra,
    findingsPath: opts.findingsPath,
    gateLog: opts.gateLog,
    args: opts.args,
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

  const result = runLlm(prompt, {
    cwd: wt,
    maxTurns,
    env,
    provider: providerName,
    avoid,
  });

  let verdict = null;
  const findingsPath = join(wt, '.agent-findings.json');
  if (existsSync(findingsPath) && agent.hard_gate) {
    try {
      const { aggregate } = await import('../runtime/gates/aggregate-verdict.mjs');
      const report = JSON.parse(readFileSync(findingsPath, 'utf8'));
      const reports = Array.isArray(report) ? report : [report];
      verdict = aggregate(reports, {
        gateRed: opts.gateRed === true,
        gateUnrun: opts.gateUnrun === true,
      });
    } catch {
      /* ignore parse errors */
    }
  }

  return {
    ok: result.status === 0 || result.skipped,
    status: result.status,
    skipped: !!result.skipped,
    provider: result.provider,
    verdict,
    wt,
    branch,
    env,
    agent: agent.name,
    source,
  };
}
