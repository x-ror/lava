/**
 * Durable execution (Temporal-like) — persist workflow state to disk so long
 * DAGs resume after process death. Not a Temporal cluster; same durability
 * contract for single-host agent runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../runtime/paths.mjs';

export function runDir(runId) {
  return join(STATE_DIR, 'runs', String(runId));
}

export function saveState(runId, state) {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'state.json.tmp');
  const dest = join(dir, 'state.json');
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, dest);
  return dest;
}

export function loadState(runId) {
  const p = join(runDir(runId), 'state.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function newRunId(issueNumber) {
  return `${issueNumber || 'adhoc'}-${Date.now()}`;
}

export function appendEvent(runId, event) {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'events.jsonl');
  writeFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', {
    flag: 'a',
  });
}
