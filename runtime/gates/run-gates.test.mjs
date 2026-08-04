/**
 * Which gate failures the pipeline may clear itself.
 *
 * The pollution ratchet reports an IMPROVEMENT as a failure — it wants the
 * tighter baseline committed — and the baseline is human-only, so `fixer`
 * cannot clear it however long it works. #91 spent fix rounds on exactly that.
 *
 * The recovery is code reading the tool's own output, never a model's judgment,
 * so what it must NOT match is the interesting half of this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecovery, findHumanOnly, failedGate } from './run-gates.mjs';

const IMPROVED = `
internal/sqlite.js: global 20 < baseline 22 — hardened by 2.

Ratchet improved — commit the tighter baseline:
  node scripts/check-primordials.mjs --update
`;

const REGRESSED = `
internal/url.js: 31 method sites, baseline 29 (+2):
  internal/url.js:88  push

Pollution ratchet FAILED: a module gained pollutable sites. The fix depends on
the class:  method/invoke -> route through primordials
`;

const STALE = `
Stale baseline entries — these files no longer exist:
  internal/gone.js
A stale entry is a ceiling waiting for a file to be re-added under the same
path, which would then inherit it instead of starting at 0.

Pollution ratchet FAILED: a module gained pollutable sites.
`;

test('an improvement is recoverable', () => {
  const r = findRecovery(IMPROVED);
  assert.ok(r, 'the ratchet asked for the tighter baseline and nothing offered to write it');
  assert.equal(r.id, 'primordials-improved');
  assert.match(r.command, /check-primordials/);
});

test('a regression is NEVER recoverable', () => {
  // Auto-updating here would record the new pollutable sites as the floor —
  // the gate erasing its own failure, which is the whole thing it exists against.
  assert.equal(findRecovery(REGRESSED), null);
});

test('a stale entry is not recoverable either', () => {
  // A deleted file drops its ceiling, so a file re-added at that path would
  // inherit nothing and start at 0. The ratchet calls this FAILED, and the word
  // is what keeps it out of the recovery path.
  assert.equal(findRecovery(STALE), null);
});

test('an improvement reported ALONGSIDE a failure is not recoverable', () => {
  // One module hardening while another regresses must not buy the regression a
  // pass. `improved` and `FAILED` can appear in the same run.
  assert.equal(findRecovery(IMPROVED + REGRESSED), null);
});

test('an unrelated failure has no recovery', () => {
  assert.equal(findRecovery('make check-js → 2\nsome other error'), null);
  assert.equal(findRecovery(''), null);
  assert.equal(findRecovery(undefined), null);
});

test('the recovery never passes --allow-raise', () => {
  // Lowering is the one direction CLAUDE.md §5 permits without a written
  // reason. Raising stays human even when the tool would allow it.
  const r = findRecovery(IMPROVED);
  assert.doesNotMatch(r.command, /allow-raise/);
  assert.doesNotMatch(r.command, /RAISE=/);
});

// ── failures no agent is allowed to fix ─────────────────────────────────────

const RAISE = `
Refusing to RAISE the baseline. These entries would go up:

  internal/url.js: method 29 -> 31 (+2)

The ratchet only moves down. Harden the sites, add \`// primordials-ok\` where
the receiver genuinely is not a built-in.
`;

const UNCAPPED = `
benchmark gate FAILED — benches without a cap or report_only opt-out:
  micro/decode-new.js
`;

const CAP_EXCEEDED = `
benchmark gate FAILED — lava/node ratio exceeded cap:
  micro/url-parse.js  2.9x > 2.2x
`;

const CASE_FLOOR = `
gate-integrity case-count: tests/node-compat/cases has 68 cases, expected >= 70 (see runtime/gates/case-counts.json)
`;

test('a raise the ratchet refuses is human-only', () => {
  const h = findHumanOnly(RAISE);
  assert.ok(h);
  assert.equal(h.path, 'tests/node-compat/pollution-baseline.json');
  assert.match(h.reason, /allow-raise/);
});

test('a bench with no cap is human-only', () => {
  const h = findHumanOnly(UNCAPPED);
  assert.ok(h);
  assert.equal(h.path, 'bench/thresholds.json');
});

test('a bench that BLEW its cap is not — make it faster', () => {
  // Loosening the cap is not the fix, so this belongs to the fixer. Classifying
  // it human-only would stop a run the agent could finish.
  assert.equal(findHumanOnly(CAP_EXCEEDED), null);
});

test('a case-count floor is not — add cases', () => {
  assert.equal(findHumanOnly(CASE_FLOOR), null);
});

test('an ordinary failure is not human-only', () => {
  assert.equal(findHumanOnly('make check → 1\nsyntax error'), null);
  assert.equal(findHumanOnly(''), null);
  assert.equal(findHumanOnly(undefined), null);
});

test('a recoverable improvement is not human-only', () => {
  // The two classifications must not both claim the same failure: one clears
  // it, the other stops the run.
  assert.equal(findHumanOnly(IMPROVED), null);
  assert.ok(findRecovery(IMPROVED));
});

test('a human-only failure is not recoverable', () => {
  assert.equal(findRecovery(RAISE), null);
  assert.equal(findRecovery(UNCAPPED), null);
});

test('a failed gate carries its classification, not just computes it', () => {
  // The wiring, not the predicate. A version that classified correctly and
  // forgot to attach the answer passed every test above.
  const ctx = { logs: ['make check-js → 2'], files: ['a.js'], targets: ['make check-js'] };
  const r = failedGate('make check-js', RAISE, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.failed, 'make check-js');
  assert.equal(r.humanOnly?.id, 'primordials-raise');
  assert.match(r.log, /human-only: primordials-raise/);
});

test('an ordinary failure carries no classification', () => {
  const ctx = { logs: ['make check → 1'], files: [], targets: ['make check'] };
  const r = failedGate('make check', 'syntax error', ctx);
  assert.equal(r.humanOnly, null);
  assert.doesNotMatch(r.log, /human-only/);
});
