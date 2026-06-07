// Circular CommonJS require() must resolve to the in-progress module's partial
// exports instead of overflowing the stack (issue #57). Pre-fix, requiring
// cycle-a recursed (the cache was populated only after eval) and threw
// RangeError: Maximum call stack size exceeded.
const assert = require('node:assert/strict');

const a = require('../fixtures/cycle-a.js');
const b = require('../fixtures/cycle-b.js');

// a finished after b, so it sees b's full exports.
assert.equal(a.name, 'a');
assert.equal(a.done, true);
assert.equal(a.bName, 'b');

// b ran during a's load, so it saw a's *partial* exports: only `name` existed
// yet (bName/done are assigned after b returns).
assert.equal(b.name, 'b');
assert.equal(b.aName, 'a');
assert.equal(b.aKeysDuringCycle, 'name');

// The module cache returns the same exports object on repeat require.
assert.equal(require('../fixtures/cycle-a.js'), a);
