/**
 * The planner's output has to reach the agents that come after it.
 *
 * It did not: planner emitted a task DAG and nothing read it, so `acceptance`
 * and `human_only` — the two fields that decide what odin-feature builds and
 * what it must refuse — never left the planner's own turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPlan } from './build-prompt.mjs';
import { invokeCommand } from './invoke.mjs';

const PLAN = {
  issue: 335,
  terminal: null,
  tasks: [
    {
      id: 't1',
      title: 'validate offsets in buffer.writeUInt8',
      depends_on: [],
      acceptance: ['throws ERR_OUT_OF_RANGE for negative offset', 'oracle case added'],
      paths_hint: ['pkg/runtime/buffer.odin'],
      human_only: false,
    },
    { id: 't2', title: 'raise the bench cap', depends_on: ['t1'], human_only: true },
  ],
};

test('acceptance criteria survive into the prompt', () => {
  const out = renderPlan(PLAN, '/wt/.agent-plan.json');
  assert.match(out, /throws ERR_OUT_OF_RANGE for negative offset/);
  assert.match(out, /oracle case added/);
});

test('human-only tasks are marked so an agent does not attempt them', () => {
  // Bench caps and manifest rewrites are hook-blocked anyway, but an agent that
  // spends a turn discovering that has already wasted the turn.
  const out = renderPlan(PLAN, '/wt/.agent-plan.json');
  assert.match(out, /raise the bench cap.*HUMAN ONLY/s);
  assert.doesNotMatch(
    out.split('\n').find((l) => l.includes('writeUInt8')),
    /HUMAN ONLY/,
  );
});

test('ordering between steps is preserved', () => {
  assert.match(renderPlan(PLAN), /t2: raise the bench cap after t1/);
});

test('an already-done issue is announced as terminal', () => {
  const out = renderPlan({ terminal: 'already-done', tasks: [] });
  assert.match(out, /TERMINAL: already-done/);
  assert.match(out, /do not re-implement/);
});

test('a plan with no tasks says so rather than rendering an empty list', () => {
  // Silence here reads as "no constraints" to the next agent.
  assert.match(renderPlan({ tasks: [] }), /no tasks/);
});

test('the file path is named so a later agent can re-read the full JSON', () => {
  assert.match(renderPlan(PLAN, '/wt/.agent-plan.json'), /\/wt\/\.agent-plan\.json/);
});

test('a plan missing optional fields does not throw', () => {
  assert.doesNotThrow(() => renderPlan({}));
  assert.doesNotThrow(() => renderPlan({ tasks: [{}] }));
  assert.match(renderPlan({ tasks: [{}] }), /untitled/);
});

/** Round-trip through the real command layer, provider `none` (writes, no LLM). */
async function invokeIn(dir, command) {
  return invokeCommand(command, {
    issue: { number: 335, title: 'buffer offsets', body: '' },
    cwd: dir,
    provider: 'none',
    worktree: false,
    source: 'human',
  });
}

test('a plan written by one agent reaches the next one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lava-plan-'));
  try {
    // planner's turn: no plan yet, so it is told where to write one.
    const first = await invokeIn(dir, 'planner');
    assert.equal(first.plan, null);
    const asked = readFileSync(join(dir, '.agent-prompt.txt'), 'utf8');
    assert.match(asked, /No plan yet.*\.agent-plan\.json/s);

    writeFileSync(join(dir, '.agent-plan.json'), JSON.stringify(PLAN));

    // odin-feature's turn: the plan is picked up off disk and put in the prompt.
    const second = await invokeIn(dir, 'odin-feature');
    assert.equal(second.plan.tasks.length, 2);
    const prompt = readFileSync(join(dir, '.agent-prompt.txt'), 'utf8');
    assert.match(prompt, /throws ERR_OUT_OF_RANGE for negative offset/);
    assert.match(prompt, /HUMAN ONLY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt plan file is dropped, not fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lava-plan-'));
  try {
    writeFileSync(join(dir, '.agent-plan.json'), '{ not json');
    const r = await invokeIn(dir, 'odin-feature');
    assert.equal(r.ok, true, 'a malformed plan must not stop the run');
    assert.equal(r.plan, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
