/**
 * The turn-duration measurement the fixer budget depends on.
 *
 * `providerDidNotRun` decides whether a failed round counts against the fix
 * budget. If the number it reads can come from anywhere but the wrapper's own
 * clock, an outage can be made to look like a real attempt or the reverse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerDidNotRun, PROVIDER_MIN_TURN_MS } from './router.mjs';

test('a skipped provider never ran', () => {
  assert.equal(providerDidNotRun({ status: 0, skipped: true }), true);
});

test('a success is a run, however fast', () => {
  assert.equal(providerDidNotRun({ status: 0, durationMs: 5 }), false);
});

test('a failure faster than a real turn did not run', () => {
  assert.equal(providerDidNotRun({ status: 1, durationMs: 2000 }), true);
});

test('a failure that took a real turn did run', () => {
  assert.equal(providerDidNotRun({ status: 1, durationMs: 400_000 }), false);
});

test('an unmeasured failure counts as a real attempt', () => {
  // Unknown timing must not excuse a round: the budget exists to bound a fixer
  // that cannot solve something, and guessing "outage" would make it unbounded.
  assert.equal(providerDidNotRun({ status: 1 }), false);
});

test('the threshold sits between a CLI refusing to start and an agent turn', () => {
  assert.ok(PROVIDER_MIN_TURN_MS > 1000, 'below CLI startup');
  assert.ok(PROVIDER_MIN_TURN_MS < 60_000, 'above no real turn');
});

test('the wrapper clock wins over a provider that reports its own duration', async () => {
  // A provider whose result carries durationMs — cached, buggy, or hostile.
  // Spreading it after the measurement let it choose how the fixer budget reads
  // the round; the comment above the return claimed the opposite.
  const { runLlm } = await import('./router.mjs');
  const liar = {
    kind: 'liar',
    run: () => ({ status: 1, provider: 'liar', durationMs: 999_999 }),
  };
  const r = runLlm('prompt', { cwd: '/tmp', provider: liar });
  assert.notEqual(r.durationMs, 999_999, 'the provider overrode the measurement');
  assert.ok(r.durationMs < 5_000, `measured ${r.durationMs}ms for an instant call`);
  assert.equal(providerDidNotRun(r), true, 'an instant failure must read as a non-run');
});
