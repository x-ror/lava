// Buffer.alloc / allocUnsafe size validation. A negative or NaN size must throw
// a catchable RangeError [ERR_OUT_OF_RANGE] rather than attempting a huge
// allocation; a non-number size throws TypeError [ERR_INVALID_ARG_TYPE].
const assert = require('node:assert/strict');
const buffer = require('node:buffer');

// Happy paths.
assert.equal(Buffer.alloc(0).length, 0);
assert.equal(Buffer.alloc(4).length, 4);
assert.deepEqual(Buffer.alloc(4), Buffer.from([0, 0, 0, 0]));
assert.equal(Buffer.allocUnsafe(8).length, 8);
// Fractional sizes truncate toward zero, matching the Uint8Array constructor.
assert.equal(Buffer.alloc(3.9).length, 3);

// Fill argument.
assert.deepEqual(Buffer.alloc(3, 7), Buffer.from([7, 7, 7]));
assert.deepEqual(Buffer.alloc(4, 'ff', 'hex'), Buffer.from([0xff, 0xff, 0xff, 0xff]));
assert.deepEqual(Buffer.alloc(5, 'ab'), Buffer.from('ababa'));

// Negative / NaN -> RangeError (no multi-gigabyte allocation attempt).
for (const bad of [-1, -100, NaN]) {
  assert.throws(() => Buffer.alloc(bad), { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' });
  assert.throws(() => Buffer.allocUnsafe(bad), { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' });
}

// Beyond MAX_LENGTH -> RangeError.
assert.throws(() => Buffer.alloc(buffer.constants.MAX_LENGTH + 1), { code: 'ERR_OUT_OF_RANGE' });

// Non-number size -> TypeError.
for (const bad of ['10', {}, null, undefined, true]) {
  assert.throws(() => Buffer.alloc(bad), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });
}

// allocUnsafeSlow and the advertised constants.
assert.equal(Buffer.allocUnsafeSlow(3).length, 3);
assert.equal(typeof buffer.constants.MAX_LENGTH, 'number');
assert.equal(buffer.kMaxLength, buffer.constants.MAX_LENGTH);
