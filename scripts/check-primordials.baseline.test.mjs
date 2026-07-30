// The ratchet's decision layer. Every case here corresponds to a mutation that
// was DEMONSTRATED to survive the suite while this logic sat inline in the CLI,
// which no test imported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, raises, totals } from './lib/primordials-baseline.mjs';

const at = (o = {}) => ({ method: 0, invoke: 0, accessor: 0, global: 0, ...o });

test('a per-class trade fails even when the total is unchanged', () => {
  // The mutation this pins: collapsing the per-class loop into one total. The
  // file below fixes one accessor and gains one live global — same total, and the
  // whole point of per-class baselines is that this must not pass.
  const { failures, improvements } = compare(
    { 'a.js': at({ accessor: 0, global: 1 }) },
    { 'a.js': at({ accessor: 1, global: 0 }) },
  );
  assert.equal(failures.length, 1);
  assert.deepEqual(
    { key: failures[0].key, kind: failures[0].kind },
    { key: 'a.js', kind: 'global' },
  );
  assert.equal(improvements.length, 1, 'the fixed accessor is still reported as an improvement');
});

test('a file absent from the baseline starts at zero in every class', () => {
  // The mutation: treating a missing entry as permissive. A brand-new unhardened
  // module would then land silently.
  const { failures } = compare({ 'new.js': at({ method: 3 }) }, {});
  assert.equal(failures.length, 1);
  assert.deepEqual({ base: failures[0].base, now: failures[0].now }, { base: 0, now: 3 });
});

test('all-below-baseline is an improvement and never a failure', () => {
  const { failures, improvements } = compare(
    { 'a.js': at({ method: 1 }) },
    { 'a.js': at({ method: 4 }) },
  );
  assert.deepEqual(failures, []);
  assert.equal(improvements.length, 1);
  assert.equal(improvements[0].base - improvements[0].now, 3);
});

test('an exact match is neither', () => {
  const same = { 'a.js': at({ method: 2, global: 7 }) };
  const { failures, improvements, stale } = compare(same, same);
  assert.deepEqual(
    { failures, improvements, stale },
    { failures: [], improvements: [], stale: [] },
  );
});

test('a baseline entry with no file is reported stale', () => {
  // The mutation: iterating only the current files. A deleted-then-readded path
  // then inherits its old ceiling — re-adding at 5 against a stale 99 read as
  // "hardened by 94" rather than as new unhardened ground.
  const { stale } = compare({ 'a.js': at() }, { 'a.js': at(), 'gone.js': at({ method: 99 }) });
  assert.deepEqual(stale, ['gone.js']);
});

test('raises() names every class that would move up, and nothing else', () => {
  // The mutation: inverting the refuse-to-raise condition, which let `--update`
  // silently raise every floor.
  const up = raises(
    { 'a.js': at({ method: 5, global: 1 }) },
    { 'a.js': at({ method: 4, global: 9 }) },
  );
  assert.equal(up.length, 1);
  assert.deepEqual(
    { kind: up[0].kind, base: up[0].base, now: up[0].now },
    {
      kind: 'method',
      base: 4,
      now: 5,
    },
  );
  assert.deepEqual(raises({ 'a.js': at({ method: 1 }) }, { 'a.js': at({ method: 4 }) }), []);
});

test('raises() treats a missing entry as a floor of zero', () => {
  const up = raises({ 'new.js': at({ invoke: 1 }) }, {});
  assert.deepEqual(
    up.map((r) => r.kind),
    ['invoke'],
  );
});

test('totals sums per class and overall', () => {
  const { perKind, total } = totals({
    'a.js': at({ method: 1, global: 2 }),
    'b.js': at({ accessor: 3 }),
  });
  assert.deepEqual(perKind, { method: 1, invoke: 0, accessor: 3, global: 2 });
  assert.equal(total, 6);
});
