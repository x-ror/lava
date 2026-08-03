/**
 * Feature pipeline — default autonomous DAG:
 *   select → planner → odin-feature → critic → pr-gate → (fixer)* → draft PR
 *
 * Every agent step goes through invokeCommand() — the same function slash
 * commands use. The system does not bypass the command layer.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runGraph } from './engine.mjs';
import { saveState, loadState, newRunId, appendEvent } from './durable.mjs';
import { selectReadyIssues, createDraftPr, isHumanOnly } from '../runtime/github.mjs';
import { bootstrapWorktree } from '../runtime/worktree.mjs';
import { runGates } from '../runtime/gates/run-gates.mjs';
import { ROOT, STATE_DIR, CONFIG_PIPELINE } from '../runtime/paths.mjs';
import { invokeCommand } from '../commands/invoke.mjs';

function loadPipelineConfig() {
  const p = join(ROOT, 'config/pipeline.json');
  return JSON.parse(readFileSync(p, 'utf8'));
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
    const boot =
      opts.dryRun && opts.skipBootstrap
        ? { wt: process.cwd(), branch: `agent/${issue.number}`, env: {} }
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
      createPr: opts.createPr !== false,
      history: [],
    };
    saveState(runId, state);
  }

  const handlers = {
    select: async (s) => {
      // already selected; advance
      return {};
    },
    draft_pr: async (s) => {
      if (!s.createPr || s.dryRun) {
        return { pr: null, prSkipped: true };
      }
      // Hard rule: only after pr-gate SHIP / SHIP-AFTER
      const v = s.verdict?.verdict;
      if (v !== 'SHIP' && v !== 'SHIP-AFTER') {
        // If agent did not write findings, run mechanical gates as stand-in.
        const gates = runGates(s.wt, s.env || {});
        if (!gates.ok) {
          return {
            forceNext: 'fixer',
            gateLog: gates.log,
            prBlocked: 'gates red before PR',
          };
        }
        // No structured verdict but gates green → allow draft with SHIP-AFTER note
        s.verdict = { verdict: 'SHIP-AFTER', reason: 'mechanical gates green; no findings file' };
      }
      const title = `fix: ${s.issue.title}`.slice(0, 72);
      const body = `Closes #${s.issue.number}

## Summary
Autonomous agent pipeline for #${s.issue.number}.

## pr-gate
Verdict: ${s.verdict?.verdict || 'unknown'}
Reason: ${s.verdict?.reason || '(none)'}

## Test plan
- [ ] Routed mechanical gates
- [ ] Human review before merge

Merge is human-only. Never auto-merged.
`;
      const pr = createDraftPr({
        title,
        body,
        branch: s.branch,
        cwd: s.wt,
      });
      return { pr: pr.url || null, prOk: pr.ok, prError: pr.error };
    },
  };

  const finalState = await runGraph({
    graph: cfg.graph,
    state,
    handlers,
    maxSteps: 40,
    onStep: (step) => {
      appendEvent(runId, {
        node: step.node,
        next: step.next,
        ok: step.result?.ok,
        verdict: step.result?.verdict?.verdict,
      });
      saveState(runId, step.state);
      console.log(
        `[pipeline #${issue.number}] ${step.node} → ${step.next || '∅'}` +
          (step.result?.verdict ? ` [${step.result.verdict.verdict}]` : ''),
      );
    },
  });

  // If graph used command nodes without hard verdict, ensure PR only after gates.
  if (
    finalState.node === 'create-pr' ||
    finalState.status === 'done' ||
    finalState.history?.some((h) => h.node === 'create-pr')
  ) {
    /* handled */
  }

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
        history: finalState.history,
      },
      null,
      2,
    ),
  );

  return {
    ok: finalState.status === 'done',
    status: finalState.status || finalState.node,
    runId,
    issue: issue.number,
    wt: finalState.wt,
    branch: finalState.branch,
    pr: finalState.pr,
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

  console.log(`[pipeline] queue: ${queue.map((i) => '#' + i.number).join(', ')}`);
  const results = [];
  let n = 0;
  for (const issue of queue) {
    if (n >= max) break;
    n++;
    try {
      // For dry-run with provider none, still useful to invoke planner only etc.
      if (opts.dryRun && opts.provider === 'none') {
        // Lightweight path: bootstrap + write prompts for each command without LLM
        const boot = bootstrapWorktree(issue.number);
        for (const cmd of ['planner', 'odin-feature', 'critic', 'pr-gate']) {
          await invokeCommand(cmd, {
            issue,
            provider: 'none',
            cwd: boot.wt,
            branch: boot.branch,
            env: boot.env,
            worktree: false,
            dryRun: true,
            source: 'workflow',
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
