// node:querystring, node:string_decoder, node:timers — newly added builtins. Exercises
// their public surface; node and lava must produce identical output.
const assert = require('node:assert/strict');
const qs = require('node:querystring');
const { StringDecoder } = require('node:string_decoder');
const timers = require('node:timers');

// --- querystring ---
assert.equal(qs.stringify({ a: 1, b: 'x y', c: [1, 2] }), 'a=1&b=x%20y&c=1&c=2');
assert.deepEqual({ ...qs.parse('a=1&a=2&b=hello+world') }, { a: ['1', '2'], b: 'hello world' });
assert.equal(qs.escape('a b+c'), 'a%20b%2Bc');
assert.equal(qs.unescape('a%20b+c'), 'a b+c');
// custom separators round-trip
assert.equal(qs.stringify({ a: 1, b: 2 }, ';', ':'), 'a:1;b:2');
assert.deepEqual({ ...qs.parse('a:1;b:2', ';', ':') }, { a: '1', b: '2' });

// --- string_decoder: a 3-byte char split across writes is decoded once whole ---
const sd = new StringDecoder('utf8');
const euro = Buffer.from('€', 'utf8'); // E2 82 AC
let out = sd.write(euro.subarray(0, 2));
out += sd.write(euro.subarray(2));
out += sd.end();
assert.equal(out, '€');
// utf16le surrogate pair split across writes
const sd16 = new StringDecoder('utf16le');
const emoji = Buffer.from('😀', 'utf16le'); // 4 bytes, a surrogate pair
let o16 = sd16.write(emoji.subarray(0, 2));
o16 += sd16.write(emoji.subarray(2));
o16 += sd16.end();
assert.equal(o16, '😀');

// --- timers: re-exports the real global timer functions ---
assert.equal(typeof timers.setTimeout, 'function');
assert.equal(typeof timers.clearTimeout, 'function');
assert.equal(typeof timers.setInterval, 'function');
assert.equal(typeof timers.setImmediate, 'function');
assert.equal(typeof timers.promises.setTimeout, 'function');

// prove the timer actually runs (and ordering: setImmediate fires after this turn)
timers.setImmediate(() => {
  console.log('ok');
});
