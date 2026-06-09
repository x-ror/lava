const assert = require('node:assert/strict');

assert.deepEqual(Buffer.from('zz', 'hex'), Buffer.alloc(0));
assert.deepEqual(Buffer.from('z', 'hex'), Buffer.alloc(0));
assert.deepEqual(Buffer.from('   ', 'base64'), Buffer.alloc(0));
