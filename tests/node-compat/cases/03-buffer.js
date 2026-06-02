const assert = require('node:assert/strict');

const input = Buffer.from('lava', 'utf8');
const copy = Buffer.alloc(4);
input.copy(copy);

assert.equal(input.toString('hex'), '6c617661');
assert.equal(copy.toString('utf8'), 'lava');
assert.equal(Buffer.concat([input, Buffer.from('-runtime')]).toString(), 'lava-runtime');

