/**
 * Reading what is on disk under `.agent-state/runs/`.
 *
 * Lives in `runtime/` rather than `workflows/` because that is where STATE_DIR
 * is defined and because the queue needs it: `selectReadyIssues` has to know
 * which issues already have a run in flight, and `runtime/` importing from
 * `workflows/` would invert the layering. The engine's WRITE side stays in
 * workflows/durable.mjs, which re-exports these for its existing callers.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './paths.mjs';

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
 * Issue numbers with a run that stopped short of a terminal node.
 *
 * Either still working or killed — from the outside those look the same, and
 * both are reasons not to start a second run on the same issue.
 *
 * @param {string} [root]
 * @returns {Set<number>}
 */
export function issuesInFlight(root = STATE_DIR) {
  const out = new Set();
  for (const r of listRuns(root)) {
    if (r.state && !isTerminal(r.state) && r.issue != null) out.add(r.issue);
  }
  return out;
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
export function checkResumable(runId, root = STATE_DIR, opts = {}) {
  const state = loadState(runId, root);
  if (!state) return { ok: false, reason: `no run ${runId} in ${join(root, 'runs')}` };
  if (isTerminal(state) && !opts.force) {
    // Reopenable with force. `needs-human-decision` is a common terminal, and
    // the human decision is often "the provider was down, try again" — #91 hit
    // exactly that and the only way back was to bypass the graph entirely.
    return {
      ok: false,
      reason: `run ${runId} already finished (${state.status}) — --force reopens it`,
    };
  }
  if (!state.wt) return { ok: false, reason: `run ${runId} recorded no worktree` };
  if (!existsSync(state.wt)) {
    return { ok: false, reason: `worktree is gone: ${state.wt}` };
  }
  return { ok: true, state };
}
