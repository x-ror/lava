const assert = require('node:assert/strict');

process.env.LAVA_NODE_COMPAT = 'enabled';

assert.equal(typeof process.cwd(), 'string');
assert.equal(process.env.LAVA_NODE_COMPAT, 'enabled');
assert.equal(Array.isArray(process.argv), true);
assert.equal(typeof process.version, 'string');
assert.equal(process.version.startsWith('v'), true);
