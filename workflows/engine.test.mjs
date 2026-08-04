/**
 * Verdict routing in the workflow engine.
 *
 * This is the safety-critical logic of the whole agent system: it decides
 * whether a run reaches `create-pr`. It shipped with no tests, and with a branch
 * that turned "the agent exited 0 but wrote no findings file" into SHIP-AFTER —
 * so a pr-gate that crashed, timed out, or ran under provider `none` opened a
 * draft PR with zero mechanical gates run. Every case below exists to keep that
 * branch from coming back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from './engine.mjs';

/** Minimal graph with the same shape as config/pipeline.json around the gate. */
const GRAPH = {
  entry: 'pr-gate',
  nodes: {
    'pr-gate': {
      type: 'command',
      command: 'pr-gate',
      hard_gate: true,
      on_ship: 'create-pr',
      on_ship_after: 'create-pr',
      on_block: 'fixer',
    },
    fixer: {
      type: 'command',
      command: 'fixer',
      max_rounds: 2,
      next: 'pr-gate',
      on_stall: 'terminal.needs-human',
    },
    'create-pr': { type: 'system', action: 'draft_pr', next: 'terminal.done' },
    'terminal.done': { type: 'terminal', status: 'done' },
    'terminal.needs-human': { type: 'terminal', status: 'needs-human-decision' },
  },
};

/** Runs the graph with a scripted sequence of pr-gate results. */
async function run(results, { handlers = {}, state = {} } = {}) {
  const queue = [...results];
  const calls = [];
  const prCalls = [];
  const final = await runGraph({
    graph: GRAPH,
    state: { issue: { number: 1, title: 't' }, wt: '/tmp/wt', ...state },
    maxSteps: 20,
    invoke: async (command) => {
      calls.push(command);
      if (command !== 'pr-gate') return { ok: true, status: 0 };
      // The last scripted result repeats: a gate that stays red stays red, so a
      // test asserting on the final verdict sees the condition it set up rather
      // than a default that leaked in once the queue drained.
      if (queue.length > 1) return queue.shift();
      return queue[0] ?? { ok: true, status: 0 };
    },
    handlers: {
      draft_pr: async () => {
        prCalls.push(true);
        return { pr: 'https://example.invalid/pr/1' };
      },
      ...handlers,
    },
  });
  return { final, calls, prs: prCalls.length };
}

test('SHIP reaches the PR node', async () => {
  const { final, prs } = await run([{ ok: true, status: 0, verdict: { verdict: 'SHIP' } }]);
  assert.equal(final.status, 'done');
  assert.equal(prs, 1);
});

test('SHIP-AFTER reaches the PR node — the autonomous ceiling, not a block', async () => {
  const { final, prs } = await run([{ ok: true, status: 0, verdict: { verdict: 'SHIP-AFTER' } }]);
  assert.equal(final.status, 'done');
  assert.equal(prs, 1);
});

test('BLOCK routes to fixer and never opens a PR', async () => {
  const { calls, prs } = await run([
    { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } },
    { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } },
    { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } },
  ]);
  assert.ok(calls.includes('fixer'));
  assert.equal(prs, 0);
});

test('a missing verdict is BLOCK, not SHIP-AFTER', async () => {
  // The regression: exit 0 with no findings file. The agent claiming success is
  // not evidence that the gate ran.
  const { final, calls, prs } = await run([{ ok: true, status: 0 }]);
  assert.equal(prs, 0, 'a PR was opened without a verdict');
  assert.ok(calls.includes('fixer'));
  assert.equal(final.verdict.verdict, 'BLOCK');
  assert.match(final.verdict.reason, /no verdict/);
});

test('a skipped provider is BLOCK and says so', async () => {
  const { final, prs } = await run([{ ok: true, status: 0, skipped: true }]);
  assert.equal(prs, 0);
  assert.equal(final.verdict.verdict, 'BLOCK');
  assert.match(final.verdict.reason, /did not run/);
});

test('a crashed gate is BLOCK', async () => {
  const { final, prs } = await run([{ ok: false, status: 137 }]);
  assert.equal(prs, 0);
  assert.equal(final.verdict.verdict, 'BLOCK');
  assert.match(final.verdict.reason, /exit 137/);
});

test('an unreadable findings file does not read as clean', async () => {
  const { final, prs } = await run([
    { ok: true, status: 0, verdictError: 'unreadable .agent-findings.json: Unexpected token' },
  ]);
  assert.equal(prs, 0);
  assert.equal(final.verdict.verdict, 'BLOCK');
});

test('the fixer loop stalls to needs-human instead of looping forever', async () => {
  const block = { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } };
  const { final, prs } = await run([block, block, block, block, block]);
  assert.equal(final.status, 'needs-human-decision');
  assert.equal(prs, 0);
});

test('a recovered gate ships after a fix round', async () => {
  const { final, prs, calls } = await run([
    { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } },
    { ok: true, status: 0, verdict: { verdict: 'SHIP', reason: 'clean' } },
  ]);
  assert.equal(calls.filter((c) => c === 'fixer').length, 1);
  assert.equal(final.status, 'done');
  assert.equal(prs, 1);
});

test('gateRed from the pipeline reaches the command layer', async () => {
  // The aggregator turns gateRed into BLOCK regardless of findings; if the flag
  // never arrives, empty findings read as clean.
  let seen = null;
  await runGraph({
    graph: GRAPH,
    state: { issue: { number: 1 }, wt: '/tmp/wt', gateRed: true },
    maxSteps: 3,
    invoke: async (_cmd, opts) => {
      seen = opts;
      return { ok: true, status: 0, verdict: { verdict: 'SHIP' } };
    },
    handlers: { draft_pr: async () => ({}) },
  });
  assert.equal(seen.gateRed, true);
});

test('a plan produced by one node is forwarded to the next', async () => {
  // planner's DAG used to stop at planner. Without this the acceptance criteria
  // never reach the agent that implements against them.
  const seen = [];
  const plan = { tasks: [{ id: 't1', title: 'x', acceptance: ['y'] }] };
  await runGraph({
    graph: {
      entry: 'planner',
      nodes: {
        planner: { type: 'command', command: 'planner', next: 'odin-feature' },
        'odin-feature': { type: 'command', command: 'odin-feature', next: 'terminal.done' },
        'terminal.done': { type: 'terminal', status: 'done' },
      },
    },
    state: { issue: { number: 1 }, wt: '/tmp/wt' },
    invoke: async (command, opts) => {
      seen.push({ command, plan: opts.plan });
      return command === 'planner' ? { ok: true, status: 0, plan } : { ok: true, status: 0 };
    },
  });
  assert.equal(seen[0].plan, undefined, 'planner runs before there is a plan');
  assert.deepEqual(seen[1].plan, plan, 'odin-feature did not receive the plan');
});

test('a system handler can divert the graph with forceNext', async () => {
  const { final } = await run([{ ok: true, status: 0, verdict: { verdict: 'SHIP' } }], {
    handlers: {
      draft_pr: async () => ({ forceNext: 'terminal.needs-human', prBlocked: 'no' }),
    },
  });
  assert.equal(final.status, 'needs-human-decision');
});

test('an unknown node is an error, not a silent stop', async () => {
  const final = await runGraph({
    graph: { entry: 'nope', nodes: {} },
    state: {},
    invoke: async () => ({ ok: true }),
  });
  assert.equal(final.status, 'error');
  assert.match(final.error, /unknown node/);
});

test('a cycle without a terminal is capped by maxSteps', async () => {
  const final = await runGraph({
    graph: { entry: 'a', nodes: { a: { type: 'command', command: 'x', next: 'a' } } },
    state: {},
    maxSteps: 5,
    invoke: async () => ({ ok: true, status: 0 }),
  });
  assert.equal(final.status, 'max-steps');
});

// ── a plan that says the work already exists ────────────────────────────────

/** The shipped graph's shape around planner, trimmed to what routing needs. */
const PLAN_GRAPH = {
  entry: 'planner',
  nodes: {
    planner: { type: 'command', command: 'planner', next: 'odin-feature' },
    'odin-feature': { type: 'command', command: 'odin-feature', next: 'terminal.done' },
    'terminal.done': { type: 'terminal', status: 'done' },
    'terminal.needs-human': { type: 'terminal', status: 'needs-human-decision' },
  },
};

async function runPlan(plan, graph = PLAN_GRAPH) {
  const calls = [];
  const final = await runGraph({
    graph,
    state: { issue: { number: 91 }, wt: '/tmp/wt' },
    maxSteps: 10,
    invoke: async (command) => {
      calls.push(command);
      return command === 'planner' ? { ok: true, status: 0, plan } : { ok: true, status: 0 };
    },
  });
  return { final, calls };
}

test('a plan reporting the work is already done stops the run', async () => {
  // #91: planner returned terminal "already-done" with zero tasks, and the
  // pipeline spent four more agent sessions before pr-gate blocked it.
  const { final, calls } = await runPlan({ terminal: 'already-done', tasks: [] });
  assert.deepEqual(calls, ['planner'], 'work continued after the plan said not to');
  assert.equal(final.status, 'needs-human-decision');
  assert.match(final.terminalReason, /already-done/);
});

test('it stops at needs-human, never at done', async () => {
  // The planner can be wrong — it was, for #91. Closing the run as `done` would
  // bury an issue on one bad conclusion; stopping to ask costs a human a minute.
  const { final } = await runPlan({ terminal: 'already-done', tasks: [] });
  assert.notEqual(final.status, 'done');
});

test('any terminal value stops it, not just already-done', async () => {
  const { final, calls } = await runPlan({ terminal: 'superseded-by-#400', tasks: [] });
  assert.deepEqual(calls, ['planner']);
  assert.match(final.terminalReason, /superseded-by-#400/);
});

test('a normal plan does not stop anything', async () => {
  const { final, calls } = await runPlan({ terminal: null, tasks: [{ id: 't1', title: 'x' }] });
  assert.deepEqual(calls, ['planner', 'odin-feature']);
  assert.equal(final.status, 'done');
  assert.equal(final.terminalReason, undefined);
});

test('a node can name its own terminal target', async () => {
  const graph = structuredClone(PLAN_GRAPH);
  graph.nodes.planner.on_terminal = 'terminal.done';
  const { final } = await runPlan({ terminal: 'already-done' }, graph);
  assert.equal(final.status, 'done');
});

test('a hard gate verdict outranks a plan opinion', async () => {
  // BLOCK is evidence; a plan is an opinion. If both arrive, the gate wins.
  const graph = {
    entry: 'pr-gate',
    nodes: {
      'pr-gate': {
        type: 'command',
        command: 'pr-gate',
        hard_gate: true,
        on_ship: 'create-pr',
        on_block: 'fixer',
      },
      fixer: { type: 'command', command: 'fixer', next: 'terminal.done' },
      'create-pr': { type: 'system', next: 'terminal.done' },
      'terminal.done': { type: 'terminal', status: 'done' },
      'terminal.needs-human': { type: 'terminal', status: 'needs-human-decision' },
    },
  };
  const calls = [];
  await runGraph({
    graph,
    state: { issue: { number: 91 }, wt: '/tmp/wt' },
    maxSteps: 6,
    invoke: async (command) => {
      calls.push(command);
      return command === 'pr-gate'
        ? { ok: true, status: 0, verdict: { verdict: 'BLOCK' }, plan: { terminal: 'already-done' } }
        : { ok: true, status: 0 };
    },
  });
  assert.ok(calls.includes('fixer'), 'a plan opinion diverted a BLOCK');
});

// ── a provider outage must not spend the fix budget ─────────────────────────

/** Drives the fixer loop with a scripted pr-gate + fixer pair. */
async function fixLoop(fixerResult, rounds = 12) {
  const calls = [];
  const final = await runGraph({
    graph: GRAPH,
    state: { issue: { number: 91 }, wt: '/tmp/wt' },
    maxSteps: rounds,
    invoke: async (command) => {
      calls.push(command);
      return command === 'pr-gate'
        ? { ok: true, status: 0, verdict: { verdict: 'BLOCK', reason: 'P0' } }
        : fixerResult();
    },
  });
  return { final, fixes: calls.filter((c) => c === 'fixer').length };
}

test('a fixer the provider never ran does not burn a round', async () => {
  // #91: three "fix rounds" in ninety seconds against a CLI that exited 1
  // without doing a turn, then needs-human — reporting a code problem when
  // nothing had been tried.
  const { final } = await fixLoop(() => ({
    ok: false,
    status: 1,
    durationMs: 2000,
    didNotRun: true,
  }));
  assert.equal(final.fixRound || 0, 0, 'an outage consumed the fix budget');
  assert.match(final.stallReason, /provider did not run/);
  assert.match(final.stallReason, /no fix was attempted/);
});

test('but consecutive outages still stop the run', async () => {
  // Not counting them must not mean spinning forever against a dead provider.
  const { final, fixes } = await fixLoop(() => ({
    ok: false,
    status: 1,
    durationMs: 2000,
    didNotRun: true,
  }));
  assert.equal(final.status, 'needs-human-decision');
  assert.ok(fixes <= 3, `stalled after ${fixes} attempts, expected to stop early`);
});

test('a fixer that really ran and failed still burns a round', async () => {
  const { final } = await fixLoop(() => ({ ok: false, status: 1, durationMs: 400_000 }));
  assert.ok(final.fixRound >= 2, 'real attempts stopped being counted');
  assert.match(final.stallReason, /without clearing the gate/);
});

test('one outage between real attempts does not reset the budget', async () => {
  // The miss counter resets on a real run; the round counter must not.
  let n = 0;
  const { final } = await fixLoop(() => {
    n++;
    return n === 2
      ? { ok: false, status: 1, durationMs: 2000, didNotRun: true }
      : { ok: false, status: 1, durationMs: 400_000 };
  });
  assert.match(final.stallReason, /without clearing the gate/);
});
