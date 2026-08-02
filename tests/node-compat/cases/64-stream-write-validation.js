// Writable#write / Readable#push: what they accept, and how they refuse the rest.
//
// This is the work reverted in #326 (787e8ea), relanded with the two things that revert
// was missing. The original failure is worth stating because it is what this case exists
// to prevent: widening the accept set WITHOUT node's normalization step left
// `chunk.length` undefined for a DataView, so `writableLength` became NaN permanently,
// `'drain'` could never fire again (`NaN === 0` is false), and `pipe()` stalled forever on
// a process-lifetime stream. And only the writable half was widened, so a PassThrough
// accepted a view on one side and errored on the other.
//
// Node's contract, measured on 24.18.1 rather than read off the docs:
//
//   write(chunk)          null                 -> THROWS ERR_STREAM_NULL_VALUES
//                         string/Buffer/       -> accepted; `_write` always receives a
//                         TypedArray/DataView     BUFFER with encoding 'buffer'
//                         anything else        -> THROWS ERR_INVALID_ARG_TYPE
//                         bad encoding         -> THROWS ERR_UNKNOWN_ENCODING, and this
//                                                 wins over a bad chunk type
//   push(chunk)           same accept set, but a refusal is an ASYNC 'error', not a throw
//
// The sync-vs-async asymmetry between write and push is node's, not an accident here.
const assert = require('node:assert/strict');
const stream = require('node:stream');

const TYPE_MSG =
  'The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView.';

// --- write: the refusal matrix, all synchronous -----------------------------------------
{
  const w = new stream.Writable({
    write(c, e, cb) {
      cb();
    },
  });

  assert.throws(
    () => w.write(null),
    { code: 'ERR_STREAM_NULL_VALUES', message: 'May not write null values to stream' },
    'write(null) must throw SYNCHRONOUSLY, not report on the stream a tick later',
  );

  const rejected = [
    ['undefined', undefined],
    ['number', 5],
    ['object', {}],
    ['function', () => {}],
    ['bigint', 10n],
    ['boolean', true],
    ['array', []],
    ['ArrayBuffer', new ArrayBuffer(4)],
    // `instanceof` is forgeable and, on its own, wrong here: this object has
    // Uint8Array.prototype in its chain but is not a view, so ArrayBuffer.isView is what
    // node's check reduces to.
    ['fake-view', Object.create(Uint8Array.prototype)],
  ];
  for (const [label, value] of rejected) {
    assert.throws(() => w.write(value), { code: 'ERR_INVALID_ARG_TYPE' }, label);
  }
  assert.throws(() => w.write(5), { message: TYPE_MSG + ' Received type number (5)' });
  assert.throws(() => w.write({}), { message: TYPE_MSG + ' Received an instance of Object' });
  assert.throws(() => w.write(new ArrayBuffer(1)), {
    message: TYPE_MSG + ' Received an instance of ArrayBuffer',
  });

  // A symbol must not be stringified on the way into the message — asserted, not just
  // claimed in a comment: `describeType` renders it through `value.toString()`, and only
  // the message pins that arm.
  assert.throws(() => w.write(Symbol('s')), {
    code: 'ERR_INVALID_ARG_TYPE',
    message: TYPE_MSG + ' Received type symbol (Symbol(s))',
  });
}

// --- encoding is validated BEFORE the chunk type ----------------------------------------
{
  const w = new stream.Writable({
    write(c, e, cb) {
      cb();
    },
  });
  assert.throws(() => w.write('x', 'bogus'), {
    code: 'ERR_UNKNOWN_ENCODING',
    message: 'Unknown encoding: bogus',
  });
  // The chunk is invalid too, and node still reports the ENCODING.
  assert.throws(() => w.write(5, 'bogus'), { code: 'ERR_UNKNOWN_ENCODING' });
  assert.throws(
    () => w.setDefaultEncoding('bogus'),
    { code: 'ERR_UNKNOWN_ENCODING' },
    'setDefaultEncoding must validate its argument',
  );
}

// --- the accept set, and what _write actually receives -----------------------------------
{
  const seen = [];
  const w = new stream.Writable({
    write(chunk, encoding, cb) {
      seen.push([Buffer.isBuffer(chunk), chunk.length, encoding]);
      cb();
    },
  });
  w.write(new DataView(new ArrayBuffer(4)));
  w.write(new Int16Array([1, 2]));
  w.write(new Float64Array(3));
  w.write(Buffer.from('ab'));
  w.write('hi');
  // Every one arrives as a Buffer with encoding 'buffer' — the normalization whose absence
  // caused the original regression.
  assert.deepEqual(seen, [
    [true, 4, 'buffer'],
    [true, 4, 'buffer'],
    [true, 24, 'buffer'],
    [true, 2, 'buffer'],
    [true, 2, 'buffer'],
  ]);
  // And the byte accounting stays a number, which is what 'drain' depends on.
  assert.equal(w.writableLength, 0);
  assert.equal(Number.isNaN(w.writableLength), false, 'writableLength must never be NaN');
}

// --- end(chunk) validates identically ----------------------------------------------------
{
  const w = new stream.Writable({
    write(c, e, cb) {
      cb();
    },
  });
  assert.throws(() => w.end(5), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.throws(() => w.end({}), { code: 'ERR_INVALID_ARG_TYPE' });
  // null and undefined mean "no chunk" to end(), NOT a bad chunk — unlike write(), where
  // null is ERR_STREAM_NULL_VALUES. Measured; the symmetric-looking assertion was wrong.
  const w2 = new stream.Writable({
    write(c, e, cb) {
      cb();
    },
  });
  w2.end(null);
  const w3 = new stream.Writable({
    write(c, e, cb) {
      cb();
    },
  });
  w3.end(undefined);
}

// --- objectMode accepts what byte mode refuses -------------------------------------------
{
  const got = [];
  const w = new stream.Writable({
    objectMode: true,
    write(c, e, cb) {
      got.push(typeof c);
      cb();
    },
  });
  w.write(5);
  w.write({});
  w.write([]);
  assert.deepEqual(got, ['number', 'object', 'object']);
  // null is still refused in objectMode.
  assert.throws(() => w.write(null), { code: 'ERR_STREAM_NULL_VALUES' });
}

// --- push: same accept set, but refusals are ASYNC ---------------------------------------
function pushOnce(value) {
  return new Promise((resolve) => {
    const r = new stream.Readable({ read() {} });
    let sync = 'ok';
    r.on('error', (e) => resolve('async:' + e.code));
    try {
      r.push(value);
    } catch (e) {
      sync = 'threw:' + e.code;
    }
    setTimeout(() => resolve(sync), 20);
  });
}

async function main() {
  assert.equal(await pushOnce(new DataView(new ArrayBuffer(2))), 'ok');
  assert.equal(await pushOnce(new Int16Array(1)), 'ok');
  assert.equal(await pushOnce(Buffer.from('a')), 'ok');
  assert.equal(await pushOnce(null), 'ok', 'push(null) is EOF, not a bad chunk');
  assert.equal(await pushOnce(new ArrayBuffer(2)), 'async:ERR_INVALID_ARG_TYPE');
  assert.equal(await pushOnce(5), 'async:ERR_INVALID_ARG_TYPE');
  assert.equal(await pushOnce({}), 'async:ERR_INVALID_ARG_TYPE');

  // --- PassThrough symmetry: a view accepted on the write side must come out the read
  // side, as a Buffer. The reverted change widened only the writable half, so this errored.
  const pt = new stream.PassThrough();
  const out = [];
  pt.on('data', (d) => out.push([Buffer.isBuffer(d), d.length]));
  pt.on('error', (e) => out.push(['ERR', e.code]));
  pt.write(new Int16Array([0x4241]));
  pt.write(new DataView(new ArrayBuffer(3)));
  pt.end();
  // Resolve on 'error' as well as 'end'. If the readable half refuses a chunk the stream
  // never ends, and awaiting 'end' alone turns a FAILURE into a HANG — in CI that is a
  // job timeout with no diff, strictly worse than a red assertion. The error is already
  // captured in `out`, so the assertion below still reports what went wrong.
  await new Promise((resolve) => {
    pt.on('end', resolve);
    pt.on('error', resolve);
  });
  assert.deepEqual(out, [
    [true, 2],
    [true, 3],
  ]);

  console.log('ok');
}

main().then(
  () => {},
  (err) => {
    process.stdout.write('FAILED: ' + err.message + '\n');
    process.exitCode = 1;
  },
);
