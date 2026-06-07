// The Performance API global (issue #63): a monotonic high-resolution now() and
// a timeOrigin. Pre-fix `performance` was undefined (ReferenceError). Assertions
// are relationships/bounds only (no timing values printed), so they are not
// timing-flaky and Node and Lava produce identical output.
const assert = require('node:assert/strict');

assert.equal(typeof performance, 'object');
assert.equal(typeof performance.now, 'function');
assert.equal(typeof performance.timeOrigin, 'number');

const a = performance.now();
assert.equal(typeof a, 'number');

let s = 0;
for (let i = 0; i < 1e6; i++) s += i;

const b = performance.now();
assert.ok(b >= a, 'performance.now() must be monotonic non-decreasing');

// timeOrigin is the Unix-epoch ms of the origin; now() is measured from it, so
// timeOrigin + now() tracks Date.now() (generous tolerance for clock skew).
assert.ok(performance.timeOrigin > 0);
assert.ok(Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 5000);
