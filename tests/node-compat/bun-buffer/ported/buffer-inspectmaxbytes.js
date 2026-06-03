const assert = require('node:assert/strict');
const buffer = require('node:buffer');
const { INSPECT_MAX_BYTES } = buffer;

const original = INSPECT_MAX_BYTES;
assert.equal(typeof INSPECT_MAX_BYTES, 'number');
assert.equal(typeof buffer.INSPECT_MAX_BYTES, 'number');

buffer.INSPECT_MAX_BYTES = 1000;
assert.equal(buffer.INSPECT_MAX_BYTES, 1000);
assert.equal(INSPECT_MAX_BYTES, original);

buffer.INSPECT_MAX_BYTES = original;
assert.equal(buffer.INSPECT_MAX_BYTES, original);

