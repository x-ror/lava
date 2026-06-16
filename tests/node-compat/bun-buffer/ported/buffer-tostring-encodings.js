// buf.toString encoding coverage and start/end clamping semantics.
const assert = require('node:assert/strict');

const buf = Buffer.from('hello');
assert.equal(buf.toString(), 'hello');
assert.equal(buf.toString('utf8'), 'hello');
assert.equal(buf.toString('utf8', 1, 3), 'el');

// A negative start clamps to 0 (it does NOT wrap like slice); start past the
// end yields ''. end clamps to the length.
assert.equal(buf.toString('utf8', -2), 'hello');
assert.equal(buf.toString('utf8', 2, -1), '');
assert.equal(buf.toString('utf8', 10), '');
assert.equal(buf.toString('utf8', 0, 100), 'hello');
assert.equal(buf.toString('utf8', 3, 3), '');

// Encodings.
assert.equal(Buffer.from([0xde, 0xad]).toString('hex'), 'dead');
assert.equal(Buffer.from('hello').toString('base64'), 'aGVsbG8=');
assert.equal(Buffer.from('hello').toString('base64url'), 'aGVsbG8');
assert.equal(Buffer.from([0xff, 0xfe]).toString('latin1'), 'ÿþ');
assert.equal(Buffer.from([0xff, 0x41]).toString('ascii'), 'A'); // ascii masks the high bit
assert.equal(Buffer.from('hi', 'utf16le').toString('utf16le'), 'hi');
assert.equal(Buffer.from('hi', 'ucs2').toString('ucs2'), 'hi');

// Unknown encoding -> TypeError [ERR_UNKNOWN_ENCODING].
assert.throws(() => buf.toString('foo'), { code: 'ERR_UNKNOWN_ENCODING', name: 'TypeError' });

// Round trips.
for (const enc of ['utf8', 'utf16le', 'latin1', 'hex', 'base64', 'base64url']) {
  const s = Buffer.from('round trip ✓', 'utf8').toString(enc);
  assert.deepEqual(Buffer.from(s, enc), Buffer.from('round trip ✓', 'utf8'));
}
