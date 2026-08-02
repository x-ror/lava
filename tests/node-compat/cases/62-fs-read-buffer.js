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
assert.equal(typeof fs.readFileSync(file, 'latin1'), 'string');
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

// --- readFile (callback form) ---------------------------------------------------------
fs.readFile(file, (err, data) => {
  assert.equal(err, null, 'readFile must not error');
  assert.equal(Buffer.isBuffer(data), true, 'readFile must deliver a Buffer');
  assert.equal(data.toString('hex'), 'deadbeef7479');

  fs.readFile(file, 'latin1', (err2, text) => {
    assert.equal(err2, null);
    assert.equal(typeof text, 'string', 'readFile with an encoding delivers a string');

    fs.rmSync(dir, { recursive: true });
    console.log('ok');
  });
});
