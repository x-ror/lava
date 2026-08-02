// fs read APIs must return a Buffer, not a bare Uint8Array.
//
// Node's contract: `readFileSync(path)` with no encoding returns a **Buffer**; with an
// encoding it returns a string. Same for the `readFile` callback form. Lava returned a
// plain `Uint8Array`, and the failure mode is the dangerous one — not a throw, but
// plausible-looking wrong output:
//
//   fs.readFileSync(p).toString('hex')   node "7479"      lava "116,121"
//
// `Uint8Array.prototype.toString` ignores its argument and joins with commas, so a hex or
// base64 digest silently becomes a decimal list. Everything Buffer-specific is affected:
// `.equals`, `.compare`, `.readUInt32BE`, `.toString('base64')`, `Buffer.concat` of read
// results, and `.indexOf` with a string needle.
//
// The bytes were always right — only the prototype was wrong — so this case checks the
// brand AND the methods that brand unlocks, rather than just `Buffer.isBuffer`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-fsbuf-'));
const file = path.join(dir, 'data.bin');
// 0xDE 0xAD 0xBE 0xEF, then "ty" — a byte sequence that is not valid UTF-8 on its own, so
// a lossy read would corrupt it visibly.
const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x74, 0x79]);
fs.writeFileSync(file, payload);

// --- readFileSync, no encoding -------------------------------------------------------
const buf = fs.readFileSync(file);
assert.equal(Buffer.isBuffer(buf), true, 'readFileSync must return a Buffer');
assert.equal(buf.constructor.name, 'Buffer', 'and it must report as one');
assert.equal(buf instanceof Uint8Array, true, 'a Buffer is still a Uint8Array');
assert.equal(buf.length, 6);

// The methods the brand unlocks — this is what actually broke in practice.
assert.equal(buf.toString('hex'), 'deadbeef7479');
assert.equal(buf.toString('base64'), '3q2+73R5');
assert.equal(buf.equals(payload), true, 'Buffer#equals must work on a read result');
assert.equal(buf.compare(payload), 0);
assert.equal(buf.readUInt32BE(0), 0xdeadbeef);
assert.equal(buf.subarray(4).toString('utf8'), 'ty');
assert.equal(buf.indexOf('ty'), 4, 'indexOf with a string needle needs the Buffer brand');
assert.equal(Buffer.concat([buf, payload]).length, 12);

// A subarray of a read result stays a Buffer (Symbol.species), as it does on node.
assert.equal(Buffer.isBuffer(buf.subarray(0, 2)), true);

// --- readFileSync with an encoding ----------------------------------------------------
// The encoding used to be IGNORED — every read decoded as UTF-8, so 'hex' returned the
// file's text rather than its hex. Each of these therefore pins a different decoder, not
// just "a string came back".
assert.equal(
  typeof fs.readFileSync(file, 'latin1'),
  'string',
  'an encoding must be decoded, not returned as a Buffer',
);
assert.equal(fs.readFileSync(file, 'latin1').length, 6);
assert.equal(fs.readFileSync(file, 'hex'), 'deadbeef7479');
assert.equal(fs.readFileSync(file, 'base64'), '3q2+73R5');
assert.equal(typeof fs.readFileSync(file, { encoding: 'latin1' }), 'string');
assert.equal(fs.readFileSync(file, { encoding: 'hex' }), 'deadbeef7479');
// encoding:null is explicitly the binary form on node, not a string.
assert.equal(Buffer.isBuffer(fs.readFileSync(file, { encoding: null })), true);

// Lossy UTF-8: the payload is not valid UTF-8, and node substitutes U+FFFD rather than
// giving up. The native's converter returned an EMPTY STRING here, which is the shape of
// bug that looks like an empty file.
const lossy = fs.readFileSync(file, 'utf8');
assert.equal(lossy.length, 5, 'invalid UTF-8 must decode lossily, not to ""');
assert.equal(lossy.charCodeAt(2), 0xfffd, 'the undecodable bytes become U+FFFD');
assert.equal(lossy.slice(-2), 'ty', 'and decoding continues past them');

// --- the error contract ----------------------------------------------------------------
assert.throws(
  () => fs.readFileSync(file, 'bogus'),
  {
    code: 'ERR_INVALID_ARG_VALUE',
    message: "The argument 'encoding' is invalid encoding. Received 'bogus'",
  },
  'an unknown encoding must be rejected, not silently treated as utf8',
);
assert.throws(() => fs.readFileSync(file, { encoding: 'bogus' }), {
  code: 'ERR_INVALID_ARG_VALUE',
});
assert.throws(() => fs.readFileSync(file, 123), {
  code: 'ERR_INVALID_ARG_TYPE',
  message:
    'The "options" argument must be one of type string or object. Received type number (123)',
});
assert.throws(() => fs.readFileSync(file, true), { code: 'ERR_INVALID_ARG_TYPE' });
// A bad encoding on the async form throws SYNCHRONOUSLY on node — it does not surface in
// the callback.
assert.throws(() => fs.readFile(file, 'bogus', () => {}), { code: 'ERR_INVALID_ARG_VALUE' });

// Node renders the offending value with util.inspect, so only a STRING is quoted. Getting
// this wrong is invisible until someone matches on the message.
assert.throws(() => fs.readFileSync(file, { encoding: 123 }), {
  message: "The argument 'encoding' is invalid encoding. Received 123",
});
assert.throws(() => fs.readFileSync(file, { encoding: {} }), {
  message: "The argument 'encoding' is invalid encoding. Received {}",
});
assert.throws(() => fs.readFileSync(file, { encoding: { a: 1 } }), {
  message: "The argument 'encoding' is invalid encoding. Received { a: 1 }",
});
assert.throws(() => fs.readFileSync(file, { encoding: [] }), {
  message: "The argument 'encoding' is invalid encoding. Received []",
});
assert.throws(() => fs.readFileSync(file, { encoding: true }), {
  message: "The argument 'encoding' is invalid encoding. Received true",
});

// NOT an error on node: a function or an array in the options slot both mean "no options"
// (getOptions treats a callback there as absent, and an array has no `.encoding`).
assert.equal(Buffer.isBuffer(fs.readFileSync(file, function () {})), true);
assert.equal(Buffer.isBuffer(fs.readFileSync(file, [])), true);

// The callback is validated BEFORE the options, which is why a forgotten callback reports
// the encoding string as the bad callback rather than complaining about the encoding.
assert.throws(() => fs.readFile(file), {
  code: 'ERR_INVALID_ARG_TYPE',
  message: 'The "cb" argument must be of type function. Received undefined',
});
assert.throws(() => fs.readFile(file, 'bogus'), {
  code: 'ERR_INVALID_ARG_TYPE',
  message: 'The "cb" argument must be of type function. Received type string (\'bogus\')',
});
assert.throws(() => fs.readFile(file, 'bogus', 123), {
  code: 'ERR_INVALID_ARG_TYPE',
  message: 'The "cb" argument must be of type function. Received type number (123)',
});
assert.throws(() => fs.readFile(file, null), {
  code: 'ERR_INVALID_ARG_TYPE',
  message: 'The "cb" argument must be of type function. Received null',
});
// ...but a bad options type still wins once the callback is valid.
assert.throws(() => fs.readFile(file, 123, () => {}), {
  code: 'ERR_INVALID_ARG_TYPE',
  message:
    'The "options" argument must be one of type string or object. Received type number (123)',
});

// --- the read result is a zero-copy view, not a copy --------------------------------
// A read large enough to escape the Buffer pool must come back as an EXACT-SIZE view:
// byteOffset 0 and a backing ArrayBuffer no bigger than the data. Both runtimes satisfy
// that only when the bytes are shared rather than copied — a copying `Buffer.from(view)`
// lands in the pool (byteOffset non-zero, ArrayBuffer 256 KB on Lava / 8 KB on node), so
// this assertion is what stops the zero-copy claim in fs.js's header from being decorative.
// Verified by mutation: swapping in the copying form turns exactly this block red.
//
// The size matters. Below the pool threshold node pools too, and the assertion holds for
// neither runtime; 64 KB is above both.
const big = path.join(dir, 'big.bin');
fs.writeFileSync(big, Buffer.alloc(65536, 7));
const bigBuf = fs.readFileSync(big);
assert.equal(bigBuf.length, 65536);
assert.equal(bigBuf.byteOffset, 0, 'a read result must not be an offset into a pool');
assert.equal(
  bigBuf.buffer.byteLength,
  65536,
  'the backing store must be exactly the file, i.e. shared not copied',
);

// --- falsy encodings mean BINARY, they are not errors ------------------------------
// node's assertEncoding is guarded `if (encoding && !Buffer.isEncoding(encoding))`, and
// readFileSync returns `options.encoding ? toString(...) : buffer`. So every falsy value
// hands back a Buffer. An earlier revision of the JS layer threw for these, which BROKE
// working code: the pre-layer native treated a non-string encoding as binary and returned
// data.
assert.equal(Buffer.isBuffer(fs.readFileSync(file, '')), true, "'' means binary");
assert.equal(Buffer.isBuffer(fs.readFileSync(file, { encoding: '' })), true);
assert.equal(Buffer.isBuffer(fs.readFileSync(file, { encoding: false })), true);
assert.equal(Buffer.isBuffer(fs.readFileSync(file, { encoding: 0 })), true);
assert.equal(Buffer.isBuffer(fs.readFileSync(file, { encoding: NaN })), true);

// 'buffer' is node's documented "give me a Buffer" spelling; getOptions SKIPS validation
// for it, so it reaches Buffer#toString and gets a different code than a bad name.
assert.throws(() => fs.readFileSync(file, 'buffer'), {
  code: 'ERR_UNKNOWN_ENCODING',
  message: 'Unknown encoding: buffer',
});
assert.throws(() => fs.readFileSync(file, { encoding: 'buffer' }), {
  code: 'ERR_UNKNOWN_ENCODING',
});

// --- ERR_INVALID_ARG_TYPE renders an object by CONSTRUCTOR, not by inspecting it -------
// node's determineSpecificType has three branches; an earlier revision implemented two and
// claimed in its comment that was the whole rule. The object branch is the reachable one:
// it is what a forgotten callback produces.
assert.throws(() => fs.readFile(file, {}), {
  message: 'The "cb" argument must be of type function. Received an instance of Object',
});
assert.throws(() => fs.readFile(file, [1, 2]), {
  message: 'The "cb" argument must be of type function. Received an instance of Array',
});
assert.throws(() => fs.readFile(file, new Date(0)), {
  message: 'The "cb" argument must be of type function. Received an instance of Date',
});
// A string longer than 28 chars is cut to its first 25 plus "..." BEFORE inspecting.
assert.throws(() => fs.readFile(file, 'y'.repeat(30)), {
  message:
    'The "cb" argument must be of type function. Received type string (\'yyyyyyyyyyyyyyyyyyyyyyyyy...\')',
});
assert.throws(() => fs.readFile(file, 'y'.repeat(28)), {
  message:
    'The "cb" argument must be of type function. Received type string (\'yyyyyyyyyyyyyyyyyyyyyyyyyyyy\')',
});

// --- path is type-checked, as node does ------------------------------------------------
// A NUMBER is deliberately absent from this list: node treats it as a file descriptor
// (readFileSync(123) gives EBADF), so rejecting it would be a new divergence.
for (const bad of [null, undefined, true, {}, []]) {
  assert.throws(() => fs.readFileSync(bad), { code: 'ERR_INVALID_ARG_TYPE' }, String(bad));
}
assert.throws(() => fs.readFileSync({}), {
  message:
    'The "path" argument must be of type string or an instance of Buffer or URL. ' +
    'Received an instance of Object',
});
// A Buffer path is accepted (it reaches the native as its string form).
assert.equal(Buffer.isBuffer(fs.readFileSync(Buffer.from(file))), true);

// --- readFile (callback form) ---------------------------------------------------------
fs.readFile('/nonexistent-lava-xyz', function (err) {
  // node calls the error callback with exactly one argument.
  assert.equal(arguments.length, 1, 'the error callback takes one argument on node');
  assert.equal(err.code, 'ENOENT');
});

fs.readFile(file, (err, data) => {
  assert.equal(err, null, 'readFile must not error');
  assert.equal(Buffer.isBuffer(data), true, 'readFile must deliver a Buffer');
  assert.equal(data.toString('hex'), 'deadbeef7479');

  fs.readFile(file, 'latin1', (err2, text) => {
    assert.equal(err2, null);
    assert.equal(typeof text, 'string', 'readFile with an encoding delivers a string');
    // The VALUE, not just the type: a `typeof` check alone passes just as well when the
    // encoding is ignored and the bytes come back decoded as UTF-8.
    assert.equal(text, 'Þ­¾ïty', 'and it is latin1-decoded');

    fs.rmSync(dir, { recursive: true });
    console.log('ok');
  });
});
