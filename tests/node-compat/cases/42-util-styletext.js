// util.styleText — ANSI text styling. node and lava must produce identical output.
const assert = require('node:assert/strict');
const { styleText } = require('node:util');

// validateStream:false forces the codes regardless of whether stdout is a TTY, so the
// output is deterministic under the (piped) oracle.
const F = { validateStream: false };

assert.equal(styleText('red', 'hi', F), '\x1b[31mhi\x1b[39m');
assert.equal(styleText('bold', 'hi', F), '\x1b[1mhi\x1b[22m');
assert.equal(styleText('bgBlue', 'x', F), '\x1b[44mx\x1b[49m');
// array: opens applied in order, closes unwound in reverse
assert.equal(
  styleText(['red', 'bold', 'underline'], 'hi', F),
  '\x1b[31m\x1b[1m\x1b[4mhi\x1b[24m\x1b[22m\x1b[39m',
);
// 'none' is a no-op style
assert.equal(styleText('none', 'x', F), 'x');
assert.equal(styleText(['none', 'green'], 'x', F), '\x1b[32mx\x1b[39m');

// default: styling is suppressed when the target stream is not a TTY (piped here)
assert.equal(styleText('red', 'plain'), 'plain');

// errors carry Node's codes
assert.throws(() => styleText('nope', 'hi', F), { code: 'ERR_INVALID_ARG_VALUE' });
assert.throws(() => styleText('red', 123, F), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => styleText(['red', 'bogus'], 'hi', F), {
  code: 'ERR_INVALID_ARG_VALUE',
});
// an invalid format is a TypeError (not just the right code)
assert.throws(() => styleText('nope', 'hi', F), TypeError);

// alias styles resolve (blackBright === gray codes)
assert.equal(styleText('blackBright', 'x', F), '\x1b[90mx\x1b[39m');
assert.equal(styleText('faint', 'x', F), '\x1b[2mx\x1b[22m');

// validateStream: a falsy non-null value forces the codes; a truthy non-boolean throws
assert.equal(styleText('red', 'hi', { validateStream: 0 }), '\x1b[31mhi\x1b[39m');
assert.throws(() => styleText('red', 'hi', { validateStream: 1 }), {
  code: 'ERR_INVALID_ARG_TYPE',
});

// util.inspect exposes the colors table and the custom-inspection symbol
const util = require('node:util');
assert.equal(typeof util.inspect.colors, 'object');
assert.equal(util.inspect.custom, Symbol.for('nodejs.util.inspect.custom'));

console.log('ok');
