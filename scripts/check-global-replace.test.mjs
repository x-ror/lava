// The detector's fixtures, as a node:test file so `make test-scripts` reports each shape
// by name rather than as one opaque self-test exit code.
//
// The three `regression:` fixtures are the shapes that shipped a false "closed
// tree-wide" claim in ROADMAP.md. They are the reason this gate exists, so they are
// asserted individually here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, ALLOWED } from './lib/global-replace-detect.mjs';
import { FIXTURES, selfTest } from './lib/global-replace-fixtures.mjs';

test('every fixture matches its expected hit count', () => {
  assert.deepEqual(selfTest(), []);
});

for (const f of FIXTURES) {
  test(`fixture: ${f.name}`, () => {
    assert.equal(scanSource(f.src, f.name).length, f.expect);
  });
}

test('a regex bound to a variable is seen (the miss that shipped a false claim)', () => {
  const src = `var RE = /[\\\\"]/g;\nfunction f(s) { return s.replace(RE, 'x'); }`;
  const hits = scanSource(src, 'mime-shape');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].via, 'binding');
});

test('a new RegExp(p, "g") binding is seen (the miss the second pass still had)', () => {
  const src = `var RE = new RegExp('a', 'g');\nfunction f(s) { return s.replace(RE, ''); }`;
  const hits = scanSource(src, 'ansi-shape');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].via, 'binding');
});

test('a non-global regex is not a spin risk and is not counted', () => {
  assert.equal(scanSource(`s.replace(/x/, 'y');`, 'x').length, 0);
  assert.equal(scanSource(`var R = /x/;\ns.replace(R, 'y');`, 'x').length, 0);
});

test('every allowlisted site carries a reason', () => {
  for (const [site, reason] of ALLOWED) {
    assert.match(site, /^[\w./-]+:\d+$/, `${site} should be file:line`);
    assert.ok(reason.length > 40, `${site} needs a real reason, got: ${reason}`);
  }
});
