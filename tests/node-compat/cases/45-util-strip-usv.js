// util.stripVTControlCharacters and util.toUSVString. node and lava must match.
const assert = require('node:assert/strict');
const util = require('node:util');

const ESC = String.fromCharCode(27); //
const BEL = String.fromCharCode(7); //
const CSI = String.fromCharCode(155); //  (8-bit CSI)
const BS = String.fromCharCode(92); // backslash (for the ESC \ string terminator)

// stripVTControlCharacters: SGR colors, cursor moves, 8-bit CSI, and OSC hyperlinks
// terminated by either BEL or ST (ESC \)
assert.equal(util.stripVTControlCharacters(ESC + '[31mred' + ESC + '[39m'), 'red');
assert.equal(util.stripVTControlCharacters(ESC + '[1mbold' + ESC + '[22m plain'), 'bold plain');
assert.equal(util.stripVTControlCharacters(ESC + '[2J' + ESC + '[H' + 'hi'), 'hi');
assert.equal(
  util.stripVTControlCharacters(ESC + ']8;;http://x' + BEL + 'link' + ESC + ']8;;' + BEL),
  'link',
);
assert.equal(
  util.stripVTControlCharacters(ESC + ']8;;http://x' + ESC + BS + 'link' + ESC + ']8;;' + ESC + BS),
  'link',
);
assert.equal(util.stripVTControlCharacters(CSI + '31mcsi' + CSI + '0m'), 'csi');
assert.equal(util.stripVTControlCharacters('no codes here'), 'no codes here');
assert.throws(() => util.stripVTControlCharacters(123), { code: 'ERR_INVALID_ARG_TYPE' });

// toUSVString: each lone surrogate becomes U+FFFD, valid pairs are kept, and the argument
// is coerced (a non-string is stringified, not rejected; a Symbol throws on coercion)
const HI = String.fromCharCode(0xd800);
const LO = String.fromCharCode(0xdc00);
const FFFD = String.fromCharCode(0xfffd);
assert.equal(util.toUSVString('a' + HI + 'b'), 'a' + FFFD + 'b');
assert.equal(util.toUSVString('a' + LO + 'b'), 'a' + FFFD + 'b');
assert.equal(util.toUSVString(LO + HI), FFFD + FFFD);
assert.equal(util.toUSVString('\u{1F600}'), '\u{1F600}');
assert.equal(util.toUSVString('plain'), 'plain');
assert.equal(util.toUSVString(123), '123');
assert.equal(util.toUSVString(null), 'null');
assert.throws(() => util.toUSVString(Symbol('x')), TypeError);

console.log('ok');
