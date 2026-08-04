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
import { findRecovery } from './run-gates.mjs';

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
