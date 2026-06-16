// Buffer.byteLength across input types/encodings and Buffer.isEncoding.
const assert = require('node:assert/strict');

// Strings by encoding.
assert.equal(Buffer.byteLength('héllo'), 6); // é is 2 UTF-8 bytes
assert.equal(Buffer.byteLength('héllo', 'utf8'), 6);
assert.equal(Buffer.byteLength('hello', 'utf16le'), 10);
assert.equal(Buffer.byteLength('deadbeef', 'hex'), 4);
assert.equal(Buffer.byteLength('aGVsbG8=', 'base64'), 5);
assert.equal(Buffer.byteLength('hello', 'ascii'), 5);
assert.equal(Buffer.byteLength('hello', 'latin1'), 5);

// Binary inputs report byteLength (not element count).
assert.equal(Buffer.byteLength(Buffer.alloc(7)), 7);
assert.equal(Buffer.byteLength(new ArrayBuffer(9)), 9);
assert.equal(Buffer.byteLength(new Uint16Array(4)), 8);
assert.equal(Buffer.byteLength(new DataView(new ArrayBuffer(5))), 5);

// An unknown or empty encoding falls back to UTF-8 for byteLength (it does NOT
// throw the way Buffer.from / toString do).
assert.equal(Buffer.byteLength('abc', 'bogus'), 3);
assert.equal(Buffer.byteLength('abc', ''), 3);
assert.equal(Buffer.byteLength('héllo', 'nonsense'), 6);

// Non-string, non-binary -> TypeError.
assert.throws(() => Buffer.byteLength(5), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });

// isEncoding.
for (const ok of [
  'utf8',
  'UTF-8',
  'utf16le',
  'ucs2',
  'latin1',
  'binary',
  'ascii',
  'hex',
  'base64',
  'base64url',
]) {
  assert.equal(Buffer.isEncoding(ok), true, ok);
}
for (const bad of ['foo', 'utf32', '', 5, null, undefined]) {
  assert.equal(Buffer.isEncoding(bad), false);
}
