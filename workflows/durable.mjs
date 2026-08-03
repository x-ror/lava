/**
 * Durable execution (Temporal-like) — persist workflow state to disk so long
 * DAGs resume after process death. Not a Temporal cluster; same durability
 * contract for single-host agent runs.
 *
 * The WRITE side. Reading `.agent-state/runs/` lives in runtime/runs.mjs, so
 * that the queue can consult it without `runtime/` importing from `workflows/`;
 * the read helpers are re-exported here for callers that want one import.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../runtime/paths.mjs';
import { runDir } from '../runtime/runs.mjs';

export {
  runDir,
  loadState,
  listRuns,
  isTerminal,
  issuesInFlight,
  findResumable,
  checkResumable,
} from '../runtime/runs.mjs';

export function saveState(runId, state, root = STATE_DIR) {
  const dir = runDir(runId, root);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'state.json.tmp');
  const dest = join(dir, 'state.json');
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, dest);
  return dest;
}

export function newRunId(issueNumber) {
  return `${issueNumber || 'adhoc'}-${Date.now()}`;
}

/**
 * Persist planner's DAG for the run.
 *
 * The authoritative copy lives in the worktree as `.agent-plan.json`, which is
 * where the agents read and write it — but a worktree is deleted once the PR is
 * open, and the plan is the only record of what the run set out to do. This is
 * the copy that outlives it.
 */
export function savePlan(runId, plan) {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'plan.json');
  const tmp = join(dir, 'plan.json.tmp');
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, dest);
  return dest;
}

export function loadPlan(runId) {
  const p = join(runDir(runId), 'plan.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function appendEvent(runId, event) {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'events.jsonl');
  writeFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', {
    flag: 'a',
  });
}
