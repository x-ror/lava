// Numeric read/write accessors, the swap helpers, and the out-of-bounds error
// shape (RangeError [ERR_OUT_OF_RANGE]).
const assert = require('node:assert/strict');

// Unsigned / signed integers, both endiannesses.
assert.equal(Buffer.from([0xff]).readUInt8(0), 255);
assert.equal(Buffer.from([0xff]).readInt8(0), -1);
assert.equal(Buffer.from([1, 2]).readUInt16LE(0), 0x0201);
assert.equal(Buffer.from([1, 2]).readUInt16BE(0), 0x0102);
assert.equal(Buffer.from([1, 2, 3, 4]).readUInt32LE(0), 0x04030201);
assert.equal(Buffer.from([0xff, 0xff, 0xff, 0xfe]).readInt32BE(0), -2);
assert.equal(Buffer.from([1, 2, 3, 4, 5, 6]).readUIntLE(0, 6), 0x060504030201);

// Floats and doubles round-trip.
{
  const f = Buffer.alloc(4);
  f.writeFloatLE(1.5, 0);
  assert.equal(f.readFloatLE(0), 1.5);
  const d = Buffer.alloc(8);
  d.writeDoubleBE(Math.PI, 0);
  assert.equal(d.readDoubleBE(0), Math.PI);
}

// BigInt accessors.
assert.equal(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]).readBigUInt64LE(0), 1n);
assert.equal(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).readBigInt64BE(0), -1n);
{
  const big = Buffer.alloc(8);
  big.writeBigUInt64LE(0x0102030405060708n, 0);
  assert.equal(big.readBigUInt64LE(0), 0x0102030405060708n);
}

// write returns the next offset.
{
  const w = Buffer.alloc(4);
  assert.equal(w.writeUInt32BE(1, 0), 4);
  assert.equal(w.writeUInt16LE(0x0102, 0), 2);
}

// Out-of-bounds reads/writes throw RangeError [ERR_OUT_OF_RANGE]; a type that
// cannot fit at all throws RangeError [ERR_BUFFER_OUT_OF_BOUNDS]; a fractional
// offset throws ERR_OUT_OF_RANGE ("an integer").
assert.throws(() => Buffer.alloc(1).readUInt8(5), { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' });
assert.throws(() => Buffer.alloc(1).writeUInt8(0, 5), {
  code: 'ERR_OUT_OF_RANGE',
  name: 'RangeError',
});
assert.throws(() => Buffer.alloc(2).readUInt32LE(0), {
  code: 'ERR_BUFFER_OUT_OF_BOUNDS',
  name: 'RangeError',
});
assert.throws(() => Buffer.alloc(4).readUInt8(1.5), {
  code: 'ERR_OUT_OF_RANGE',
  name: 'RangeError',
});

// swap16/32/64 and the multiple-of-N requirement.
assert.deepEqual(Buffer.from([1, 2, 3, 4]).swap16(), Buffer.from([2, 1, 4, 3]));
assert.deepEqual(Buffer.from([1, 2, 3, 4]).swap32(), Buffer.from([4, 3, 2, 1]));
assert.deepEqual(
  Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).swap64(),
  Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]),
);
assert.throws(() => Buffer.from([1, 2, 3]).swap16(), {
  code: 'ERR_INVALID_BUFFER_SIZE',
  name: 'RangeError',
});
