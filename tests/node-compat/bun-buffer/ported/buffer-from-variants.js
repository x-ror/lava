// Buffer.from across its accepted input shapes, plus the rejection paths.
const assert = require('node:assert/strict');

// Strings, default and explicit encodings.
assert.deepEqual(Buffer.from('abc'), Buffer.from([0x61, 0x62, 0x63]));
assert.equal(Buffer.from('deadBEEF', 'hex').toString('hex'), 'deadbeef');
assert.equal(Buffer.from('aGVsbG8=', 'base64').toString(), 'hello');
assert.equal(Buffer.from('aGVsbG8', 'base64url').toString(), 'hello');
assert.equal(Buffer.from('', 'utf8').length, 0);

// Array and array-like objects (each element coerced to a byte).
assert.deepEqual(Buffer.from([1, 2, 300, -1]), Buffer.from([1, 2, 44, 255]));
assert.deepEqual(Buffer.from({ length: 3, 0: 65, 1: 66 }), Buffer.from([65, 66, 0]));
assert.equal(Buffer.from({ length: 0 }).length, 0);
// A hostile/odd length must not wrap to a huge allocation: negative and NaN
// lengths yield an empty Buffer, fractional lengths floor (matching Node).
assert.equal(Buffer.from({ length: -1 }).length, 0);
assert.equal(Buffer.from({ length: -2 }).length, 0);
assert.equal(Buffer.from({ length: NaN }).length, 0);
assert.equal(Buffer.from({ length: 2.9, 0: 1, 1: 2 }).length, 2);

// Typed arrays copy element values; Buffer copies bytes.
assert.deepEqual(Buffer.from(new Uint8Array([1, 2, 3])), Buffer.from([1, 2, 3]));
assert.deepEqual(Buffer.from(new Uint16Array([0x1234, 0x5678])), Buffer.from([0x34, 0x78]));

// Copying a Buffer is a deep copy (mutating the copy must not touch the source).
{
  const src = Buffer.from([1, 2, 3]);
  const copy = Buffer.from(src);
  copy[0] = 9;
  assert.equal(src[0], 1);
}

// ArrayBuffer with offset/length is a *view* that shares the backing store.
{
  const u = new Uint8Array([1, 2, 3, 4]);
  const view = Buffer.from(u.buffer, 1, 2);
  assert.deepEqual(view, Buffer.from([2, 3]));
  view[0] = 9;
  assert.equal(u[1], 9); // shared memory
}

// {type:'Buffer', data:[...]} round-trips through JSON.
{
  const original = Buffer.from('hello');
  const revived = Buffer.from(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(revived, original);
}

// Boxed String / valueOf / Symbol.toPrimitive.
assert.equal(Buffer.from(new String('abc')).toString(), 'abc');
assert.equal(Buffer.from({ valueOf: () => 'hi' }).toString(), 'hi');
assert.equal(Buffer.from({ [Symbol.toPrimitive]: () => 'yo' }).toString(), 'yo');

// Rejections: numbers, booleans, null, undefined, bare objects.
for (const bad of [5, true, null, undefined, {}]) {
  assert.throws(() => Buffer.from(bad), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });
}

// Buffer.of and isBuffer.
assert.deepEqual(Buffer.of(1, 2, 3), Buffer.from([1, 2, 3]));
assert.equal(Buffer.isBuffer(Buffer.from([1])), true);
assert.equal(Buffer.isBuffer(new Uint8Array(1)), false);
assert.equal(Buffer.isBuffer('x'), false);
