// Buffer.concat argument validation and length handling.
const assert = require('node:assert/strict');

assert.equal(Buffer.concat([Buffer.from('a'), Buffer.from('bc')]).toString(), 'abc');
assert.equal(Buffer.concat([]).length, 0);

// Explicit totalLength truncates or zero-pads.
assert.equal(Buffer.concat([Buffer.from('abc'), Buffer.from('de')], 4).toString(), 'abcd');
{
  const padded = Buffer.concat([Buffer.from('ab')], 4);
  assert.equal(padded.length, 4);
  assert.deepEqual(padded, Buffer.from([0x61, 0x62, 0, 0]));
}

// Uint8Arrays are accepted alongside Buffers.
assert.deepEqual(Buffer.concat([new Uint8Array([1, 2]), Buffer.from([3])]), Buffer.from([1, 2, 3]));

// A non-array list throws.
assert.throws(() => Buffer.concat('xx'), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });
assert.throws(() => Buffer.concat(Buffer.from('x')), { code: 'ERR_INVALID_ARG_TYPE' });

// A non-Buffer list element throws (named list[i]).
assert.throws(() => Buffer.concat([1]), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });
assert.throws(() => Buffer.concat([Buffer.from('a'), 'b']), { code: 'ERR_INVALID_ARG_TYPE' });

// An empty list ignores a bad length, but a non-empty list validates it.
assert.equal(Buffer.concat([], -1).length, 0);
assert.throws(() => Buffer.concat([Buffer.from('a')], -1), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => Buffer.concat([Buffer.from('a')], 2.5), { code: 'ERR_OUT_OF_RANGE' });
