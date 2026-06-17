// UTF-8 decoding follows the Unicode "U+FFFD substitution of maximal subparts"
// rule (issue #107), matching Node/V8 and the WHATWG decoder: an ill-formed
// subsequence collapses to a single replacement character rather than one per
// byte. Previously the codec replaced per byte (e.g. [0xF0,0x9F] -> "��").
const assert = require('node:assert/strict');

const cps = (buf) => [...buf.toString('utf8')].map((c) => c.codePointAt(0));

// Truncated multi-byte leads -> exactly one replacement.
assert.deepEqual(cps(Buffer.from([0xf0, 0x9f])), [0xfffd]);
assert.deepEqual(cps(Buffer.from([0xe2, 0x82])), [0xfffd]);
assert.deepEqual(cps(Buffer.from([0xf0])), [0xfffd]);

// Standalone invalid bytes are one replacement each.
assert.deepEqual(cps(Buffer.from([0xff, 0xff, 0xff])), [0xfffd, 0xfffd, 0xfffd]);
assert.deepEqual(cps(Buffer.from([0xc0, 0xaf])), [0xfffd, 0xfffd]); // overlong C0 lead is invalid
assert.deepEqual(cps(Buffer.from([0xed, 0xa0, 0x80])), [0xfffd, 0xfffd, 0xfffd]); // UTF-16 surrogate

// The canonical mixed case from the Unicode standard.
assert.deepEqual(
  cps(Buffer.from([0x61, 0xf1, 0x80, 0x80, 0xe1, 0x80, 0xc2, 0x62])),
  [0x61, 0xfffd, 0xfffd, 0xfffd, 0x62],
);

// Valid sequences still decode; embedded NUL is preserved (not truncated).
assert.equal(Buffer.from([0xf0, 0x9f, 0x98, 0x80]).toString('utf8'), '😀');
assert.deepEqual(
  [...Buffer.from([0x61, 0x00, 0x62]).toString('utf8')].map((c) => c.charCodeAt(0)),
  [97, 0, 98],
);
