// A CommonJS module's stack-trace lines must report the user's own source line,
// not a wrapper-shifted line (issue #29). The module wrapper used to prepend a
// newline, so a throw on line 4 was reported as line 5. We extract just the line
// number from the (engine-specific) stack string so Node and Lava — whose frame
// formats differ — both assert the same value.
const assert = require('node:assert/strict');
const { boom } = require('../fixtures/stack-thrower.js');

const THROW_LINE = '4'; // the `throw` in fixtures/stack-thrower.js

let threw = false;
try {
  boom();
} catch (e) {
  threw = true;
  const frame = String(e.stack)
    .split('\n')
    .find((l) => l.includes('stack-thrower.js'));
  assert.ok(frame, 'expected a stack frame in stack-thrower.js');
  const m = frame.match(/stack-thrower\.js:(\d+)/);
  assert.ok(m, `could not parse a line number from frame: ${frame}`);
  assert.equal(m[1], THROW_LINE);
}
assert.ok(threw, 'boom() should have thrown');
