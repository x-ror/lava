/**
 * Issue-trigger dispatch ledger.
 *
 * The first version stored a flat list of numbers and added an issue to it right
 * after dispatch, regardless of what the pipeline did. A run that failed was
 * therefore never retried, and re-labelling an issue did nothing — the trigger
 * looked alive while quietly refusing all the work it had already touched once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDispatch, parseLedger } from './issues.mjs';

test('an unseen issue is dispatched', () => {
  assert.equal(shouldDispatch({ number: 1 }, undefined).dispatch, true);
});

test('a completed issue is not re-run', () => {
  const rec = { status: 'done', attempts: 1, updatedAt: 'T1' };
  assert.equal(shouldDispatch({ number: 1, updatedAt: 'T1' }, rec).dispatch, false);
});

test('a completed issue IS re-run once a human touches it', () => {
  const rec = { status: 'done', attempts: 1, updatedAt: 'T1' };
  const d = shouldDispatch({ number: 1, updatedAt: 'T2' }, rec);
  assert.equal(d.dispatch, true);
  assert.match(d.reason, /updated/);
});

test('a failed issue is retried', () => {
  const rec = { status: 'failed', attempts: 1, updatedAt: 'T1' };
  const d = shouldDispatch({ number: 1, updatedAt: 'T1' }, rec);
  assert.equal(d.dispatch, true, 'a failure must not be permanent');
  assert.match(d.reason, /retry 2\/3/);
});

test('retries stop at the attempt ceiling instead of looping forever', () => {
  const rec = { status: 'failed', attempts: 3, updatedAt: 'T1' };
  const d = shouldDispatch({ number: 1, updatedAt: 'T1' }, rec);
  assert.equal(d.dispatch, false);
  assert.match(d.reason, /gave up/);
});

test('an issue left in `running` by a crash still burns its attempts', () => {
  // The attempt is recorded before the pipeline runs, so a reproducible crash
  // converges on "gave up" rather than re-dispatching on every poll.
  const rec = { status: 'running', attempts: 3, updatedAt: 'T1' };
  assert.equal(shouldDispatch({ number: 1, updatedAt: 'T1' }, rec).dispatch, false);
});

test('the old flat-list ledger migrates instead of re-running everything', () => {
  const led = parseLedger(JSON.stringify({ numbers: [335, 247] }));
  assert.equal(led.issues[335].status, 'done');
  assert.equal(shouldDispatch({ number: 335 }, led.issues[335]).dispatch, false);
});

test('a corrupt or missing ledger does not wedge the trigger', () => {
  assert.deepEqual(parseLedger('{not json'), { issues: {} });
  assert.deepEqual(parseLedger(null), { issues: {} });
});
