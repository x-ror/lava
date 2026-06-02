const assert = require('node:assert/strict');
const path = require('node:path');
const helper = require('../fixtures/commonjs-helper.cjs');
const data = require('../fixtures/data.json');

assert.equal(helper.add(20, 22), 42);
assert.equal(helper.name, 'commonjs-helper');
assert.equal(data.runtime, 'lava');
assert.equal(data.compat, 'node');
assert.equal(path.basename(__filename), '00-commonjs.js');
assert.equal(path.basename(__dirname), 'cases');
assert.equal(module.children.length >= 1, true);

