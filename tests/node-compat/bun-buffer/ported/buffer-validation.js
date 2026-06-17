// Offset/value/byteLength validation parity with Node (issue #107). Negative
// and non-integer offsets throw ERR_OUT_OF_RANGE instead of wrapping from the
// end; write values are range-checked; the variable-width accessors require an
// integer byteLength in 1..6; and an unrepresentable fill value is rejected.
const assert = require('node:assert/strict');

const OOR = { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' };

// write/fill/copy reject negative & non-integer offsets (no wrap-around).
assert.throws(() => Buffer.alloc(5).write('ab', -1), OOR);
assert.throws(() => Buffer.alloc(5).write('ab', 6), OOR);
assert.throws(() => Buffer.alloc(5).write('ab', 1.5), OOR);
assert.equal(Buffer.alloc(5).write('ab', 5), 0); // offset === length writes nothing

assert.throws(() => Buffer.alloc(5).fill(9, -1), OOR);
assert.throws(() => Buffer.alloc(5).fill(9, 0, -1), OOR);
assert.throws(() => Buffer.alloc(5).fill(9, 0, 6), OOR);
assert.throws(() => Buffer.alloc(5).fill(9, 1.5), OOR);
assert.deepEqual([...Buffer.alloc(5).fill(9, 6)], [0, 0, 0, 0, 0]); // start past end: no fill

assert.throws(() => Buffer.from([1, 2, 3]).copy(Buffer.alloc(5), -1), OOR);
assert.throws(() => Buffer.from([1, 2, 3]).copy(Buffer.alloc(5), 0, -1), OOR);
assert.throws(() => Buffer.from([1, 2, 3]).copy(Buffer.alloc(5), 0, 0, -1), OOR);
assert.equal(Buffer.from([1, 2, 3]).copy(Buffer.alloc(5), 6), 0); // targetStart past end: 0

// fill value: a non-empty string that decodes to no bytes, or an empty buffer,
// is ERR_INVALID_ARG_VALUE; the empty string zero-fills the range.
assert.throws(() => Buffer.alloc(3).fill('z', 'hex'), { code: 'ERR_INVALID_ARG_VALUE' });
assert.throws(() => Buffer.alloc(3).fill(Buffer.alloc(0)), { code: 'ERR_INVALID_ARG_VALUE' });
assert.throws(() => Buffer.alloc(3, 'z', 'hex'), { code: 'ERR_INVALID_ARG_VALUE' });
assert.deepEqual([...Buffer.alloc(3, 7).fill('')], [0, 0, 0]);

// write value range validation (fixed + variable width + bigint).
assert.throws(() => Buffer.alloc(1).writeUInt8(256), OOR);
assert.throws(() => Buffer.alloc(1).writeUInt8(-1), OOR);
assert.throws(() => Buffer.alloc(1).writeInt8(128), OOR);
assert.throws(() => Buffer.alloc(1).writeInt8(-129), OOR);
assert.throws(() => Buffer.alloc(2).writeUInt16LE(65536), OOR);
assert.throws(() => Buffer.alloc(2).writeInt16LE(-32769), OOR);
assert.throws(() => Buffer.alloc(4).writeUInt32LE(2 ** 32), OOR);
assert.throws(() => Buffer.alloc(1).writeIntLE(200, 0, 1), OOR);
assert.throws(() => Buffer.alloc(3).writeUIntLE(2 ** 24, 0, 3), OOR);
assert.throws(() => Buffer.alloc(8).writeBigUInt64LE(2n ** 64n), OOR);
assert.throws(() => Buffer.alloc(8).writeBigInt64LE(2n ** 63n), OOR);

// a fractional but in-range value is floored (no throw); an over-range
// fractional value still throws.
{
  const b = Buffer.alloc(1);
  assert.equal(b.writeUInt8(1.9), 1);
  assert.equal(b[0], 1);
}
assert.throws(() => Buffer.alloc(1).writeUInt8(255.5), OOR);

// variable-width byteLength must be an integer in 1..6.
assert.throws(() => Buffer.alloc(6).readUIntLE(0), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => Buffer.alloc(6).readUIntLE(0, 0), OOR);
assert.throws(() => Buffer.alloc(8).readUIntLE(0, 7), OOR);
assert.throws(() => Buffer.alloc(6).readUIntLE(0, 1.5), OOR);
assert.throws(() => Buffer.alloc(8).writeUIntLE(1, 0, 7), OOR);

// valid round-trips still work.
{
  const b = Buffer.alloc(6);
  b.writeUIntLE(0xffffffffff, 0, 5);
  assert.equal(b.readUIntLE(0, 5), 0xffffffffff);
  b.writeIntBE(-2, 0, 3);
  assert.equal(b.readIntBE(0, 3), -2);
}
