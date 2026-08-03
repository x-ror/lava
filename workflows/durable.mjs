/**
 * Durable execution (Temporal-like) — persist workflow state to disk so long
 * DAGs resume after process death. Not a Temporal cluster; same durability
 * contract for single-host agent runs.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../runtime/paths.mjs';

export function runDir(runId, root = STATE_DIR) {
  return join(root, 'runs', String(runId));
}

/**
 * Statuses the engine assigns when a graph reaches a terminal node. Anything
 * else — including no status at all — is a run that stopped without finishing.
 */
const TERMINAL = new Set(['done', 'needs-human-decision']);

/** @param {object|null} state */
export function isTerminal(state) {
  return !!state && TERMINAL.has(state.status);
}

/**
 * Every recorded run, newest first.
 *
 * @param {string} [root] state directory; injectable so this is testable
 * @returns {{runId: string, state: object|null, issue: number|null, node: string|null,
 *            status: string|null, startedAt: number}[]}
 */
export function listRuns(root = STATE_DIR) {
  const dir = join(root, 'runs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const runId of readdirSync(dir)) {
    let state = null;
    try {
      state = JSON.parse(readFileSync(join(dir, runId, 'state.json'), 'utf8'));
    } catch {
      // A run killed mid-write, or a directory that is not a run. Reported with
      // a null state rather than dropped, so it is visible instead of missing.
    }
    // The id is `<issue>-<epoch-ms>`; sorting on it beats mtime, which every
    // later write to the directory would disturb.
    const startedAt = Number(String(runId).split('-').pop()) || 0;
    out.push({
      runId,
      state,
      issue: state?.issue?.number ?? null,
      node: state?.node ?? null,
      status: state?.status ?? null,
      startedAt,
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The newest run that stopped without reaching a terminal node.
 *
 * @param {{issue?: number, root?: string}} [opts]
 */
export function findResumable(opts = {}) {
  const runs = listRuns(opts.root);
  return (
    runs.find(
      (r) => r.state && !isTerminal(r.state) && (opts.issue == null || r.issue === opts.issue),
    ) || null
  );
}

/**
 * Load a run and check it can actually be continued.
 *
 * The worktree is the work. A resumed run reuses the one the killed attempt was
 * building in — its branch, its edits, the plan the planner had already written.
 * If that directory is gone there is nothing to resume TO, and silently
 * bootstrapping a fresh one would look like a resume while starting over.
 *
 * @param {string} runId
 * @param {string} [root]
 * @returns {{ok: true, state: object} | {ok: false, reason: string}}
 */
export function checkResumable(runId, root = STATE_DIR) {
  const state = loadState(runId, root);
  if (!state) return { ok: false, reason: `no run ${runId} in ${join(root, 'runs')}` };
  if (isTerminal(state)) {
    return { ok: false, reason: `run ${runId} already finished (${state.status})` };
  }
  if (!state.wt) return { ok: false, reason: `run ${runId} recorded no worktree` };
  if (!existsSync(state.wt)) {
    return { ok: false, reason: `worktree is gone: ${state.wt}` };
  }
  return { ok: true, state };
}

export function saveState(runId, state, root = STATE_DIR) {
  const dir = runDir(runId, root);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'state.json.tmp');
  const dest = join(dir, 'state.json');
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, dest);
  return dest;
}

export function loadState(runId, root = STATE_DIR) {
  const p = join(runDir(runId, root), 'state.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    // Killed between the write and the rename, or truncated on a full disk.
    // A resume must not die on this; the caller reports "no run" instead.
    return null;
  }
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
