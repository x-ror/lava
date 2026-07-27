const assert = require('node:assert/strict');

// TextEncoder is utf-8 only
const encoder = new TextEncoder();
assert.equal(encoder.encoding, 'utf-8');
assert.deepEqual(encoder.encode('héllo'), new Uint8Array([104, 195, 169, 108, 108, 111]));
assert.deepEqual(encoder.encode(''), new Uint8Array([]));
assert.deepEqual(encoder.encode('€'), new Uint8Array([226, 130, 172]));
assert.deepEqual(encoder.encode('😀'), new Uint8Array([240, 159, 152, 128]));

// encodeInto reports code units read and bytes written, and stops at capacity
const dest = new Uint8Array(10);
assert.deepEqual(encoder.encodeInto('abc€', dest), { read: 4, written: 6 });
assert.deepEqual(Array.from(dest.slice(0, 6)), [97, 98, 99, 226, 130, 172]);
assert.deepEqual(encoder.encodeInto('a€b', new Uint8Array(4)), { read: 2, written: 4 });

// TextDecoder defaults and the common encodings
const decoder = new TextDecoder();
assert.equal(decoder.encoding, 'utf-8');
assert.equal(decoder.fatal, false);
assert.equal(decoder.ignoreBOM, false);
assert.equal(decoder.decode(new Uint8Array([104, 195, 169])), 'hé');
assert.equal(new TextDecoder('utf-16le').decode(new Uint8Array([0x68, 0, 0xe9, 0])), 'hé');

// WHATWG aliases latin1/ascii to windows-1252, with the exact high-byte table
assert.equal(new TextDecoder('latin1').encoding, 'windows-1252');
assert.equal(new TextDecoder('ascii').encoding, 'windows-1252');
assert.equal(new TextDecoder('UTF-16LE').encoding, 'utf-16le');
assert.equal(new TextDecoder('windows-1252').decode(new Uint8Array([0x80, 0xe9])), '€é');

// BOM is stripped by default, kept with ignoreBOM
assert.equal(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), 'A');
assert.equal(
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))
    .length,
  2,
);

// WHATWG label handling: ASCII whitespace is stripped, other Unicode whitespace
// is not (Node has its own ASCII-only trim for exactly this), and the remaining
// windows-1252 aliases resolve.
assert.equal(new TextDecoder(' \t utf-8 \r\n').encoding, 'utf-8');
assert.throws(() => new TextDecoder(' utf-8'), RangeError);
assert.throws(() => new TextDecoder('　utf-8'), RangeError);
assert.throws(() => new TextDecoder('utf-8'), RangeError);
for (const label of ['iso-ir-100', 'iso_8859-1', 'iso_8859-1:1987', 'csisolatin1'])
  assert.equal(new TextDecoder(label).encoding, 'windows-1252');

// A label object is coerced exactly once, and the error names what was coerced.
{
  let calls = 0;
  assert.throws(
    () =>
      new TextDecoder({
        toString() {
          calls++;
          return 'zz-bogus';
        },
      }),
    { name: 'RangeError', code: 'ERR_ENCODING_NOT_SUPPORTED' },
  );
  assert.equal(calls, 1);
}

// Inputs larger than the 0x2000-code-unit chunk of the string builder: the
// decoder assembles the result in slices, so the seams must be invisible.
for (const n of [8191, 8192, 8193, 16384, 16385]) {
  const latin = new Uint8Array(n);
  for (let i = 0; i < n; i++) latin[i] = 0x41 + (i % 26);
  const out = new TextDecoder('windows-1252').decode(latin);
  assert.equal(out.length, n);
  assert.equal(out.charCodeAt(0), 0x41);
  assert.equal(out.charCodeAt(n - 1), 0x41 + ((n - 1) % 26));

  const u16 = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) u16[i * 2] = 0x41 + (i % 26);
  const out16 = new TextDecoder('utf-16le').decode(u16);
  assert.equal(out16.length, n);
  assert.equal(out16.charCodeAt(n - 1), 0x41 + ((n - 1) % 26));
}

// error modes
assert.throws(() => new TextDecoder('made-up'), RangeError);
assert.throws(() => new TextDecoder('made-up'), {
  name: 'RangeError',
  code: 'ERR_ENCODING_NOT_SUPPORTED',
  message: 'The "made-up" encoding is not supported',
});
assert.throws(
  () => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])),
  TypeError,
);
assert.equal(new TextDecoder().decode(new Uint8Array([0xff])), '�');

// accepts ArrayBuffer and views, and is exposed as a global
assert.equal(decoder.decode(new Uint8Array([0x41]).buffer), 'A');
assert.equal(globalThis.TextEncoder, TextEncoder);
assert.equal(globalThis.TextDecoder, TextDecoder);

// --- {stream:true}: an incomplete multi-byte sequence carries to the next call ---
{
  const d = new TextDecoder(); // utf-8
  assert.equal(d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }), '');
  assert.equal(d.decode(new Uint8Array([0xac])), '€'); // completed across chunks
}
{
  const d = new TextDecoder('utf-16le'); // surrogate pair split across chunks
  assert.equal(d.decode(new Uint8Array([0x3d, 0xd8]), { stream: true }), '');
  assert.equal(d.decode(new Uint8Array([0x00, 0xde])), '😀');
}
{
  const d = new TextDecoder('utf-16le'); // odd trailing byte held until paired
  assert.equal(d.decode(new Uint8Array([0x41]), { stream: true }), '');
  assert.equal(d.decode(new Uint8Array([0x00])), 'A');
}
{
  const d = new TextDecoder(); // a BOM split across stream chunks is still stripped once
  assert.equal(d.decode(new Uint8Array([0xef, 0xbb]), { stream: true }), '');
  assert.equal(d.decode(new Uint8Array([0xbf, 0x61])), 'a');
}

// --- maximal-subpart U+FFFD substitution: one replacement per ill-formed run ---
assert.equal(new TextDecoder().decode(new Uint8Array([0xf0, 0x9f])), '�');
assert.deepEqual(
  [
    ...new TextDecoder().decode(new Uint8Array([0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62])),
  ].map((c) => c.codePointAt(0)),
  [97, 0xfffd, 0xfffd, 0xfffd, 98],
);

// --- utf-16le lone surrogates: U+FFFD (non-fatal), error (fatal) ---
assert.equal(new TextDecoder('utf-16le').decode(new Uint8Array([0x00, 0xd8])), '�');
assert.throws(
  () => new TextDecoder('utf-16le', { fatal: true }).decode(new Uint8Array([0x00, 0xd8])),
  {
    code: 'ERR_ENCODING_INVALID_ENCODED_DATA',
  },
);
// fatal: an incomplete tail is allowed mid-stream and only throws when flushed
{
  const d = new TextDecoder('utf-16le', { fatal: true });
  assert.equal(d.decode(new Uint8Array([0x41]), { stream: true }), '');
  assert.throws(() => d.decode(), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
}
{
  const d = new TextDecoder('utf-8', { fatal: true });
  assert.equal(d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }), '');
  assert.throws(() => d.decode(), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
}
