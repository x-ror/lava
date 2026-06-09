const assert = require('node:assert/strict');

const a = Buffer.alloc(10, 0x61);
const b = Buffer.alloc(10, 0x62);

assert.throws(() => a.compare(b, 0, 100));
assert.throws(() => a.compare(b, 0, 10, 0, 100));

assert.equal(a.compare(b, 100), 1);
assert.equal(a.compare(b, 0, 10, 100), -1);

assert.throws(() => a.compare(b, 100, 50));
assert.throws(() => a.compare(b, 0, 10, 100, 50));
assert.throws(() => a.compare(b, 100, 50, 0, 40));
assert.throws(() => a.compare(b, 0, 10, 0, 40));

assert.equal(Buffer.from([1, 2, 3, 4, 5]).compare(Buffer.from([3, 4, 5, 6, 7]), 0, 3, 2), 0);

assert.equal(a.compare(b, 0, 5, 3, 3), -1);
assert.equal(a.compare(b, 3, 3, 0, 5), 1);
assert.equal(a.compare(b, 3, 3, 3, 3), 0);
assert.equal(a.compare(b, 10, 10, 0, 5), 1);
assert.equal(a.compare(b, 0, 5, 10, 10), -1);
assert.equal(a.compare(b, 0, 10, 0, 10), -1);

assert.throws(() => a.compare(b, 0, 11, 0, 10));
assert.throws(() => a.compare(b, 0, 10, 0, 11));
