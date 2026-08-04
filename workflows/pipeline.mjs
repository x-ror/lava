/**
 * Feature pipeline — default autonomous DAG:
 *   select → planner → odin-feature → critic → gates → pr-gate → (fixer)* → draft PR
 *
 * Every agent step goes through invokeCommand() — the same function slash
 * commands use. The system does not bypass the command layer.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runGraph } from './engine.mjs';
import { saveState, loadState, newRunId, appendEvent } from './durable.mjs';
import { selectReadyIssues, createDraftPr, isHumanOnly } from '../runtime/github.mjs';
import { bootstrapWorktree } from '../runtime/worktree.mjs';
import { runGates } from '../runtime/gates/run-gates.mjs';
import { ROOT, STATE_DIR } from '../runtime/paths.mjs';
import { invokeCommand } from '../commands/invoke.mjs';

function loadPipelineConfig() {
  const p = join(ROOT, 'config/pipeline.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * System-node handlers for one issue.
 *
 * `deps` exists so the two decisions that can push code off this machine — is
 * the gate green, and may a PR be opened — are testable without a worktree, a
 * toolchain, or a network. They were untestable and therefore untested.
 *
 * @param {object} issue
 * @param {{ runGates?: Function, createDraftPr?: Function }} [deps]
 */
export function makeHandlers(issue, deps = {}) {
  const gates = deps.runGates || runGates;
  const openPr = deps.createDraftPr || createDraftPr;

  return {
    select: async () => ({}),

    // The trust boundary. pr-gate runs the mechanical gates too, but that run is
    // self-reported by the agent; this one is the pipeline's own, and it is what
    // sets gateRed — which the aggregator turns into BLOCK regardless of what
    // the findings file claims.
    gates: async (s) => {
      if (s.dryRun) {
        return { gateRed: false, gateUnrun: true, gateLog: '(dry run: gates not executed)' };
      }
      const g = gates(s.wt, s.env || {});
      if (!g.ok) {
        console.log(`[pipeline #${issue.number}] gates RED at ${g.failed}`);
        // Some failures the fixer is forbidden to clear — the only correct fix
        // is a file in PROTECTED_WRITE_PATHS. Sending it to the fix loop burns
        // the budget and then misreports the outcome as "fixer ran N times
        // without clearing the gate", when nothing was ever permitted to try.
        if (g.humanOnly) {
          console.log(
            `[pipeline #${issue.number}] human-only: ${g.humanOnly.reason} (${g.humanOnly.path})`,
          );
          return {
            forceNext: 'terminal.needs-human',
            gateRed: true,
            gateUnrun: false,
            gateLog: g.log,
            gateFailed: g.failed,
            humanOnly: g.humanOnly,
            stallReason: `${g.failed}: ${g.humanOnly.reason}`,
          };
        }
        return {
          forceNext: 'fixer',
          gateRed: true,
          gateUnrun: false,
          gateLog: g.log,
          gateFailed: g.failed,
        };
      }
      return { gateRed: false, gateUnrun: false, gateLog: null, gateTargets: g.targets };
    },

    draft_pr: async (s) => {
      if (!s.createPr || s.dryRun) {
        return { pr: null, prSkipped: true };
      }
      // Defense in depth: the graph only routes here on SHIP / SHIP-AFTER, but
      // this is the single place a PR can be created, so it re-checks rather
      // than trusting the edge it arrived on.
      const v = s.verdict?.verdict;
      if (v !== 'SHIP' && v !== 'SHIP-AFTER') {
        return {
          pr: null,
          prBlocked: `verdict ${v || 'none'} — a PR requires SHIP or SHIP-AFTER`,
          forceNext: 'terminal.needs-human',
        };
      }

      // Final gate before anything leaves the machine, mutations included. The
      // fix→verify loop skips `make test-mutation` because it re-applies the
      // whole manifest; skipping it everywhere would be gate-weakening
      // (CLAUDE.md §6), so it runs exactly once, here.
      const final = gates(s.wt, s.env || {}, { runMutation: true });
      if (!final.ok) {
        return {
          forceNext: 'fixer',
          gateRed: true,
          gateLog: final.log,
          prBlocked: `final gate red at ${final.failed}`,
        };
      }

      const title = `fix: ${s.issue.title}`.slice(0, 72);
      const body = `Closes #${s.issue.number}

## Summary
Autonomous agent pipeline for #${s.issue.number}.

## pr-gate
Verdict: ${s.verdict?.verdict || 'unknown'}
Reason: ${s.verdict?.reason || '(none)'}

## Gates
Ran: ${(final.targets || []).join(', ') || 'make check'}

## Test plan
- [ ] Routed mechanical gates (above) re-checked by a human
- [ ] Human review before merge

Merge is human-only. Never auto-merged.
`;
      const pr = openPr({ title, body, branch: s.branch, cwd: s.wt });
      return { pr: pr.url || null, prOk: pr.ok, prError: pr.error };
    },
  };
}

/**
 * Process one issue through the full DAG.
 */
export async function runIssuePipeline(issue, opts = {}) {
  if (isHumanOnly(issue)) {
    return { status: 'skipped', reason: 'human-only', issue: issue.number };
  }

  const cfg = loadPipelineConfig();
  const runId = opts.runId || newRunId(issue.number);
  let state = opts.resume ? loadState(runId) : null;

  if (!state) {
    // Bootstrap isolation up front so every command shares one worktree.
    // `--no-worktree` runs the graph in place — a development path for
    // exercising the DAG without a bun install. It must never push, so it forces
    // --no-pr rather than opening a PR from the main tree.
    const inPlace = opts.worktree === false;
    const boot = inPlace
      ? { wt: opts.cwd || process.cwd(), branch: null, env: {} }
      : bootstrapWorktree(issue.number);
    state = {
      runId,
      issue,
      node: cfg.graph.entry,
      wt: boot.wt,
      branch: boot.branch,
      env: boot.env,
      provider: opts.provider || process.env.AGENT_PROVIDER || 'auto',
      dryRun: !!opts.dryRun,
      maxTurns: opts.maxTurns,
      maxFixRounds: cfg.policy?.max_fix_rounds || 3,
      fixRound: 0,
      createPr: opts.createPr !== false && !inPlace,
      source: opts.source || 'workflow',
      history: [],
    };
    saveState(runId, state);
  }

  const finalState = await runGraph({
    graph: cfg.graph,
    state,
    handlers: makeHandlers(issue),
    maxSteps: 40,
    onStep: (step) => {
      appendEvent(runId, {
        node: step.node,
        next: step.next,
        ok: step.result?.ok,
        verdict: step.state?.verdict?.verdict,
      });
      saveState(runId, step.state);
      console.log(
        `[pipeline #${issue.number}] ${step.node} → ${step.next || '∅'}` +
          (step.state?.verdict ? ` [${step.state.verdict.verdict}]` : ''),
      );
    },
  });

  saveState(runId, finalState);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(
    join(STATE_DIR, 'last-run.json'),
    JSON.stringify(
      {
        runId,
        issue: issue.number,
        status: finalState.status,
        pr: finalState.pr,
        prBlocked: finalState.prBlocked,
        verdict: finalState.verdict,
        history: finalState.history,
      },
      null,
      2,
    ),
  );

  return {
    ok: finalState.status === 'done' && !finalState.prBlocked,
    status: finalState.status || finalState.node,
    runId,
    issue: issue.number,
    wt: finalState.wt,
    branch: finalState.branch,
    pr: finalState.pr,
    prBlocked: finalState.prBlocked,
    verdict: finalState.verdict,
    history: finalState.history,
  };
}

/**
 * Drain ready issues (or explicit list). System auto-start entrypoint.
 */
export async function runPipeline(opts = {}) {
  const max = opts.once ? 1 : (opts.max ?? 20);
  const queue = selectReadyIssues({
    issues: opts.issues,
    includeUnlabeled: !!opts.issues,
  });

  if (!queue.length) {
    console.log('[pipeline] queue empty');
    return { ok: true, results: [], queue: [] };
  }

  if (opts.worktree === false && opts.createPr !== false) {
    console.warn('[pipeline] --no-worktree implies --no-pr (refusing to push the main tree)');
  }

  console.log(`[pipeline] queue: ${queue.map((i) => '#' + i.number).join(', ')}`);
  const results = [];
  let n = 0;
  for (const issue of queue) {
    if (n >= max) break;
    n++;
    try {
      // Prompt-only sweep: bootstrap once, write every agent's prompt, run no
      // LLM. Useful for reading what the system would send before paying for it.
      if (opts.dryRun && opts.provider === 'none') {
        const boot =
          opts.worktree === false
            ? { wt: opts.cwd || process.cwd(), branch: null, env: {} }
            : bootstrapWorktree(issue.number);
        for (const cmd of ['planner', 'odin-feature', 'critic', 'pr-gate']) {
          await invokeCommand(cmd, {
            issue,
            provider: 'none',
            cwd: boot.wt,
            branch: boot.branch,
            env: boot.env,
            worktree: false,
            dryRun: true,
            source: opts.source || 'workflow',
          });
        }
        results.push({
          issue: issue.number,
          status: 'dry-run',
          wt: boot.wt,
          branch: boot.branch,
        });
        continue;
      }
      const r = await runIssuePipeline(issue, opts);
      results.push(r);
    } catch (e) {
      console.error(`[pipeline] #${issue.number} error: ${e.message}`);
      results.push({ issue: issue.number, status: 'error', error: e.message, ok: false });
    }
  }

  return {
    ok: results.every((r) => r.ok || r.status === 'dry-run' || r.status === 'skipped'),
    results,
  };
}
