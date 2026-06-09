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

// error modes
assert.throws(() => new TextDecoder('made-up'), RangeError);
assert.throws(
  () => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])),
  TypeError,
);
assert.equal(new TextDecoder().decode(new Uint8Array([0xff])), '�');

// accepts ArrayBuffer and views, and is exposed as a global
assert.equal(decoder.decode(new Uint8Array([0x41]).buffer), 'A');
assert.equal(globalThis.TextEncoder, TextEncoder);
assert.equal(globalThis.TextDecoder, TextDecoder);
