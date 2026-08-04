/**
 * Resume.
 *
 * The durable state was written on every step and read back by nobody:
 * `opts.resume` had no setter anywhere in the tree, and `newRunId()` minted a
 * fresh id per call, so even a caller that set it would have looked up a run
 * that never existed. Three comments and a docs table said DAGs survive process
 * restart; killing one started it over, in a new worktree, on a new branch,
 * abandoning the plan the planner had already written.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listRuns,
  isTerminal,
  findResumable,
  checkResumable,
  saveState,
  loadState,
} from './durable.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'lava-durable-'));
}

/** Write a run record straight to disk, the way a live pipeline would. */
function seed(root, runId, state) {
  const dir = join(root, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state ?? {}, null, 2));
  return dir;
}

test('a run that reached a terminal node is finished', () => {
  assert.equal(isTerminal({ status: 'done' }), true);
  assert.equal(isTerminal({ status: 'needs-human-decision' }), true);
});

test('a run with no status at all is NOT finished', () => {
  // This is the killed-mid-flight shape: the engine only ever assigns a status
  // when it reaches a terminal node, so absence means "stopped", not "clean".
  assert.equal(isTerminal({ node: 'planner' }), false);
  assert.equal(isTerminal({ status: 'stuck' }), false);
  assert.equal(isTerminal({ status: 'max-steps' }), false);
  assert.equal(isTerminal(null), false);
});

test('runs are listed newest first, by the timestamp in the id', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner' });
    seed(root, '91-3000', { issue: { number: 91 }, node: 'critic' });
    seed(root, '77-2000', { issue: { number: 77 }, node: 'pr-gate' });
    assert.deepEqual(
      listRuns(root).map((r) => r.runId),
      ['91-3000', '77-2000', '91-1000'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run killed mid-write is listed, not skipped', () => {
  // Dropping it would hide exactly the run most likely to need attention.
  const root = scratch();
  try {
    const dir = join(root, 'runs', '91-1000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"issue": {"num');
    const runs = listRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent runs directory is empty, not an error', () => {
  const root = scratch();
  try {
    assert.deepEqual(listRuns(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findResumable picks the newest unfinished run', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner' });
    seed(root, '91-3000', { issue: { number: 91 }, status: 'done' });
    assert.equal(findResumable({ root }).runId, '91-1000', 'a finished run was offered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findResumable can be pinned to one issue', () => {
  const root = scratch();
  try {
    seed(root, '77-3000', { issue: { number: 77 }, node: 'critic' });
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner' });
    assert.equal(findResumable({ root, issue: 91 }).runId, '91-1000');
    assert.equal(findResumable({ root, issue: 5 }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nothing to resume returns null rather than throwing', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'done' });
    assert.equal(findResumable({ root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a resumable run carries its worktree forward', () => {
  const root = scratch();
  const wt = mkdtempSync(join(tmpdir(), 'lava-wt-'));
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner', wt, branch: 'agent/91' });
    const r = checkResumable('91-1000', root);
    assert.equal(r.ok, true);
    assert.equal(r.state.wt, wt, 'resume must continue in the worktree the run was building in');
    assert.equal(r.state.node, 'planner');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test('a run whose worktree is gone is refused, not silently restarted', () => {
  // Bootstrapping a fresh worktree here would look like a resume while
  // discarding every edit and the plan the run had already produced.
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner', wt: '/nonexistent/wt-91' });
    const r = checkResumable('91-1000', root);
    assert.equal(r.ok, false);
    assert.match(r.reason, /worktree is gone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a finished run is refused with its status', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'done', wt: '/tmp' });
    const r = checkResumable('91-1000', root);
    assert.equal(r.ok, false);
    assert.match(r.reason, /already finished \(done\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown run id is refused by name', () => {
  const root = scratch();
  try {
    const r = checkResumable('nope-1', root);
    assert.equal(r.ok, false);
    assert.match(r.reason, /no run nope-1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state survives a save/load round trip under an injected root', () => {
  const root = scratch();
  try {
    const state = {
      issue: { number: 91 },
      node: 'critic',
      wt: '/tmp/wt',
      history: [{ node: 'a' }],
    };
    saveState('91-1000', state, root);
    assert.deepEqual(loadState('91-1000', root), state);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated state file loads as null instead of throwing', () => {
  const root = scratch();
  try {
    const dir = join(root, 'runs', '91-1000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"node"');
    assert.equal(loadState('91-1000', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reopening a terminal run ────────────────────────────────────────────────

test('a finished run is refused by default and offered with force', () => {
  // #91 closed as needs-human-decision because the provider was down, not
  // because the code was unfixable. The only way back was to bypass the graph.
  const root = scratch();
  const wt = mkdtempSync(join(tmpdir(), 'lava-wt-'));
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'needs-human-decision', wt });
    const refused = checkResumable('91-1000', root);
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /--force reopens it/);

    const forced = checkResumable('91-1000', root, { force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.state.wt, wt);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }
});

test('force does not excuse a missing worktree', () => {
  // There is still nothing to resume into; force reopens a decision, not a hole.
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'done', wt: '/nonexistent/wt' });
    const r = checkResumable('91-1000', root, { force: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /worktree is gone/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
