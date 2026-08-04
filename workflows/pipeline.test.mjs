/**
 * The two pipeline decisions that can push code off this machine.
 *
 * `draft_pr` is the only place a PR is created and `gates` is the only run of
 * the mechanical gates the system performs itself. Both were unreachable from a
 * test — the handlers were closures inside runIssuePipeline, so the guard that
 * enforces "PR only after pr-gate" had nothing pinning it. `makeHandlers` takes
 * its two effectful dependencies as arguments for exactly this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHandlers } from './pipeline.mjs';
import { runGraph } from './engine.mjs';
import { ROOT } from '../runtime/paths.mjs';

const ISSUE = { number: 335, title: 'do a thing' };
const GREEN = { ok: true, log: '', files: ['pkg/x.odin'], targets: ['make check'] };
const RED = {
  ok: false,
  log: 'boom',
  files: ['pkg/x.odin'],
  targets: ['make check'],
  failed: 'make check',
};

function harness({
  gate = () => GREEN,
  pr = () => ({ ok: true, url: 'https://x.invalid/1' }),
} = {}) {
  const gateCalls = [];
  const prCalls = [];
  const handlers = makeHandlers(ISSUE, {
    runGates: (wt, env, opts) => {
      gateCalls.push(opts || {});
      return gate();
    },
    createDraftPr: (args) => {
      prCalls.push(args);
      return pr();
    },
  });
  return { handlers, gateCalls, prCalls };
}

const shippable = (verdict) => ({
  createPr: true,
  dryRun: false,
  wt: '/tmp/wt',
  env: {},
  branch: 'agent/335',
  issue: ISSUE,
  verdict,
});

test('BLOCK never opens a PR', async () => {
  const { handlers, prCalls } = harness();
  const out = await handlers.draft_pr(shippable({ verdict: 'BLOCK', reason: 'P0' }));
  assert.equal(prCalls.length, 0);
  assert.equal(out.pr, null);
  assert.match(out.prBlocked, /requires SHIP/);
  assert.equal(out.forceNext, 'terminal.needs-human');
});

test('a missing verdict never opens a PR', async () => {
  const { handlers, prCalls } = harness();
  const out = await handlers.draft_pr(shippable(undefined));
  assert.equal(prCalls.length, 0);
  assert.match(out.prBlocked, /verdict none/);
});

test('SHIP opens a draft PR', async () => {
  const { handlers, prCalls } = harness();
  const out = await handlers.draft_pr(shippable({ verdict: 'SHIP', reason: 'clean' }));
  assert.equal(prCalls.length, 1);
  assert.equal(out.pr, 'https://x.invalid/1');
  assert.match(prCalls[0].body, /Merge is human-only/);
});

test('SHIP-AFTER opens a draft PR and records the reason', async () => {
  const { handlers, prCalls } = harness();
  await handlers.draft_pr(shippable({ verdict: 'SHIP-AFTER', reason: 'open P1' }));
  assert.equal(prCalls.length, 1);
  assert.match(prCalls[0].body, /SHIP-AFTER/);
  assert.match(prCalls[0].body, /open P1/);
});

test('SHIP with a red final gate does not open a PR', async () => {
  const { handlers, prCalls } = harness({ gate: () => RED });
  const out = await handlers.draft_pr(shippable({ verdict: 'SHIP' }));
  assert.equal(prCalls.length, 0);
  assert.equal(out.forceNext, 'fixer');
  assert.match(out.prBlocked, /final gate red/);
});

test('the final pre-PR gate runs mutations; the fix loop does not', async () => {
  // Skipping test-mutation everywhere is gate-weakening (CLAUDE.md §6); running
  // it every fix round makes the loop unusable. It belongs exactly once, here.
  const { handlers, gateCalls } = harness();
  await handlers.gates({ wt: '/tmp/wt', env: {} });
  assert.equal(gateCalls[0].runMutation, undefined);
  await handlers.draft_pr(shippable({ verdict: 'SHIP' }));
  assert.equal(gateCalls[1].runMutation, true);
});

test('a dry run neither gates nor pushes', async () => {
  const { handlers, gateCalls, prCalls } = harness();
  const g = await handlers.gates({ wt: '/tmp/wt', env: {}, dryRun: true });
  assert.equal(gateCalls.length, 0);
  assert.equal(g.gateUnrun, true, 'a dry run must not read as a green gate');
  const p = await handlers.draft_pr({ ...shippable({ verdict: 'SHIP' }), dryRun: true });
  assert.equal(prCalls.length, 0);
  assert.equal(p.prSkipped, true);
});

test('red gates route to fixer and set gateRed for the aggregator', async () => {
  const { handlers } = harness({ gate: () => RED });
  const out = await handlers.gates({ wt: '/tmp/wt', env: {} });
  assert.equal(out.forceNext, 'fixer');
  assert.equal(out.gateRed, true);
  assert.equal(out.gateFailed, 'make check');
});

test('green gates clear gateRed so a stale red cannot linger', async () => {
  const { handlers } = harness();
  const out = await handlers.gates({ wt: '/tmp/wt', env: {} });
  assert.equal(out.gateRed, false);
  assert.equal(out.gateUnrun, false);
});

/** The graph the system actually ships, not a fixture of it. */
function shippedGraph() {
  return JSON.parse(readFileSync(join(ROOT, 'config/pipeline.json'), 'utf8')).graph;
}

test('the shipped graph puts a system gate run between critic and pr-gate', async () => {
  const g = shippedGraph();
  assert.equal(g.nodes.critic.next, 'gates');
  assert.equal(g.nodes.gates.type, 'system');
  assert.equal(g.nodes.gates.next, 'pr-gate');
  // Every fix round is re-verified mechanically before the gate sees it again.
  assert.equal(g.nodes.fixer.next, 'gates');
});

test('the shipped graph reaches create-pr only through pr-gate', async () => {
  const g = shippedGraph();
  const intoPr = Object.entries(g.nodes)
    .filter(([, n]) =>
      ['next', 'on_ship', 'on_ship_after', 'on_block', 'on_fail'].some((k) => n[k] === 'create-pr'),
    )
    .map(([name]) => name);
  assert.deepEqual(intoPr, ['pr-gate'], `create-pr is reachable from ${intoPr.join(', ')}`);
});

test('a full run over the shipped graph opens one PR on SHIP', async () => {
  const prCalls = [];
  const handlers = makeHandlers(ISSUE, {
    runGates: () => GREEN,
    createDraftPr: (a) => {
      prCalls.push(a);
      return { ok: true, url: 'https://x.invalid/1' };
    },
  });
  const final = await runGraph({
    graph: shippedGraph(),
    state: { issue: ISSUE, wt: '/tmp/wt', env: {}, branch: 'agent/335', createPr: true },
    handlers,
    maxSteps: 40,
    invoke: async (command) => ({
      ok: true,
      status: 0,
      verdict: command === 'pr-gate' ? { verdict: 'SHIP', reason: 'clean' } : undefined,
    }),
  });
  assert.equal(final.status, 'done');
  assert.equal(prCalls.length, 1);
});

test('a full run over the shipped graph opens no PR when pr-gate stays silent', async () => {
  // The end-to-end shape of the fail-open regression: every command exits 0 and
  // nobody writes a findings file.
  const prCalls = [];
  const handlers = makeHandlers(ISSUE, {
    runGates: () => GREEN,
    createDraftPr: (a) => {
      prCalls.push(a);
      return { ok: true, url: 'https://x.invalid/1' };
    },
  });
  const final = await runGraph({
    graph: shippedGraph(),
    state: { issue: ISSUE, wt: '/tmp/wt', env: {}, branch: 'agent/335', createPr: true },
    handlers,
    maxSteps: 40,
    invoke: async () => ({ ok: true, status: 0 }),
  });
  assert.equal(prCalls.length, 0, 'a PR was opened with no verdict anywhere in the run');
  assert.equal(final.status, 'needs-human-decision');
});

test('a gate only a human can clear stops the run instead of feeding the fixer', async () => {
  // #91: the ratchet asked for a baseline the hook forbids the fixer to write.
  // Sending it to the fix loop burned the budget and then reported "fixer ran 3
  // times without clearing the gate" — which was never what happened.
  const handlers = makeHandlers(ISSUE, {
    runGates: () => ({
      ...RED,
      humanOnly: { id: 'primordials-raise', path: 'tests/node-compat/pollution-baseline.json', reason: 'needs --allow-raise' },
    }),
    createDraftPr: () => ({ ok: true }),
  });
  const out = await handlers.gates({ wt: '/tmp/wt', env: {} });
  assert.equal(out.forceNext, 'terminal.needs-human', 'a human-only gate went to the fixer');
  assert.match(out.stallReason, /allow-raise/);
  assert.equal(out.humanOnly.path, 'tests/node-compat/pollution-baseline.json');
});

test('an ordinary red gate still goes to the fixer', async () => {
  const handlers = makeHandlers(ISSUE, {
    runGates: () => RED,
    createDraftPr: () => ({ ok: true }),
  });
  const out = await handlers.gates({ wt: '/tmp/wt', env: {} });
  assert.equal(out.forceNext, 'fixer');
  assert.equal(out.humanOnly, undefined);
});
