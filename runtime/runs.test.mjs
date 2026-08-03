/**
 * Which issues are already being worked on.
 *
 * The trigger path refused a second dispatch from the start. The drain path did
 * not look at run state at all, so `make agent-run` took the top of the queue
 * every single invocation — six concurrent runs on #91, six worktrees, six
 * agents doing the same work, six PRs waiting to happen. Closing the guard on
 * one of two entry points and calling it closed is the mistake this pins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { issuesInFlight } from './runs.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'lava-runs-'));
}

function seed(root, runId, state) {
  const dir = join(root, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
}

test('an unfinished run marks its issue busy', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'critic' });
    assert.deepEqual([...issuesInFlight(root)], [91]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a finished run does not', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'done' });
    seed(root, '77-1000', { issue: { number: 77 }, status: 'needs-human-decision' });
    assert.deepEqual([...issuesInFlight(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a killed run still holds its issue', () => {
  // No status means the engine never reached a terminal node. From outside,
  // "still working" and "killed" look the same — and both are reasons not to
  // start a second run.
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'planner' });
    assert.equal(issuesInFlight(root).has(91), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an issue with both a finished and an unfinished run is busy', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, status: 'done' });
    seed(root, '91-2000', { issue: { number: 91 }, node: 'gates' });
    assert.equal(issuesInFlight(root).has(91), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('several issues in flight are all reported', () => {
  const root = scratch();
  try {
    seed(root, '91-1000', { issue: { number: 91 }, node: 'critic' });
    seed(root, '103-1000', { issue: { number: 103 }, node: 'planner' });
    seed(root, '104-1000', { issue: { number: 104 }, status: 'done' });
    assert.deepEqual(
      [...issuesInFlight(root)].sort((a, b) => a - b),
      [91, 103],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt or issue-less record does not claim a number', () => {
  const root = scratch();
  try {
    const dir = join(root, 'runs', '91-1000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{ truncated');
    seed(root, 'adhoc-2000', { node: 'planner' });
    assert.deepEqual([...issuesInFlight(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no runs directory means nothing is in flight', () => {
  const root = scratch();
  try {
    assert.deepEqual([...issuesInFlight(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
