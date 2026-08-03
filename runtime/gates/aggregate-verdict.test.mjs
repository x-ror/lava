import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, normalizeFinding } from './aggregate-verdict.mjs';

test('empty findings with green gates → SHIP', () => {
  const r = aggregate([{ agent: 'a', findings: [] }], { gateRed: false, gateUnrun: false });
  assert.equal(r.verdict, 'SHIP');
});

test('gate red → BLOCK even with empty findings', () => {
  const r = aggregate([{ agent: 'a', findings: [] }], { gateRed: true });
  assert.equal(r.verdict, 'BLOCK');
});

test('P1 → SHIP-AFTER (no self-waive)', () => {
  const r = aggregate(
    [
      {
        agent: 'a',
        findings: [{ id: '1', severity: 'P1', what: 'x', file: 'a.js', line: 1, fix: 'y' }],
      },
    ],
    { gateRed: false },
  );
  assert.equal(r.verdict, 'SHIP-AFTER');
});

test('parity class cannot stay P2', () => {
  const f = normalizeFinding({
    severity: 'P2',
    class: 'parity',
    what: 'node diverges',
    file: 'x.js',
    line: 1,
  });
  assert.equal(f.severity, 'P1');
});

test('finding without file/evidence is discarded', () => {
  const f = normalizeFinding({ severity: 'P0', what: 'vague' });
  assert.equal(f.discard, true);
});
