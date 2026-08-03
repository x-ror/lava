// Internal modules must not resolve Buffer through the mutable `node:buffer` exports.
//
// §5's "capture intrinsics at module-eval" rule is sound only for the modules the LOADER
// instantiates before user code. A LAZY internal module's factory does not run until user
// code calls require() for it, so its own `require('buffer').Buffer` reads whatever the
// exports object holds by then — and that object is the one user code holds too.
//
// Node is not steerable this way: its internals use the buffer binding, not the public
// module. Measured before the fix, with `require('buffer').Buffer = shim` set BEFORE the
// first require of each module:
//
//   net   sock.write('PAYLOAD')          node "PAYLOAD"    lava "TAMPERED"
//   http  res.end('PAYLOAD')             node "\nPAYLOAD"  lava "TAMPERED"
//   os    userInfo({encoding:'buffer'})  node real values  lava steerable, and WORSE —
//                                        it re-read the live export on every call, so it
//                                        was steerable at any time, not just before the
//                                        first require.
//
// loader.js now snapshots Buffer immediately after it eager-instantiates the module and
// hands it to every internal module as `require.pristineBuffer`.
//
// The shim below corrupts ONLY the exact payload string. A broad shim would also corrupt
// console.log — which is how the first version of this probe "proved" node was affected
// too: the output itself had gone through Buffer.from.
const assert = require('node:assert/strict');

// NOTHING under test may be required above this line. An earlier version of this case
// required `net` first, so net.js captured the real Buffer whichever way it resolved it —
// and the assertion below passed with the fix REVERTED. Verified by mutation.
const bufferModule = require('node:buffer');
const RealBuffer = bufferModule.Buffer;

function Shim() {}
Shim.prototype = RealBuffer.prototype;
for (const key of Object.getOwnPropertyNames(RealBuffer)) {
  try {
    Shim[key] = RealBuffer[key];
  } catch {
    // length/name are non-writable; nothing here depends on them.
  }
}
const touched = [];
Shim.from = function (value, a, b) {
  touched.push(typeof value === 'string' ? value.slice(0, 12) : typeof value);
  // Corrupting only the exact payload keeps console.log intact — a broad shim rewrites the
  // test's own output, which is how the first version of this probe "proved" node was
  // affected too.
  if (value === 'PAYLOAD') return RealBuffer.from('TAMPERED');
  return RealBuffer.from(value, a, b);
};
bufferModule.Buffer = Shim;

// Required only AFTER the swap — this is the whole point. A module that captured Buffer at
// its own module-eval takes the shim here.
const net = require('node:net');
const os = require('node:os');

// Drives an http server over a RAW net client: Lava has no http.request. The client
// destroys on first data — a `Connection: close` raw client otherwise hangs under Lava,
// which would turn a failure into a CI timeout with no diff.
function httpEcho(payload, chunked) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => res.end(chunked ? body : payload));
    });
    server.on('error', reject);
    server.listen(0, () => {
      const c = net.connect(server.address().port, () => {
        if (!chunked) {
          c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
          return;
        }
        // Split mid-size-line so the reassembly path (Buffer.concat) and the latin1 size
        // read are both exercised; a split mid-body never reaches them.
        c.write(
          'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nAAAA\r\n1',
        );
        setTimeout(() => c.write('0\r\nBBBBBBBBBBBBBBBB\r\n0\r\n\r\n'), 10);
      });
      let raw = '';
      c.on('data', (d) => {
        raw += d;
        c.destroy();
        server.close();
        resolve(raw.slice(raw.indexOf('\r\n\r\n') + 4));
      });
      c.on('error', reject);
    });
  });
}

function netRoundTrip(payload) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on('data', (d) => {
        resolve(d.toString('utf8'));
        sock.end();
        server.close();
      });
    });
    server.on('error', reject);
    server.listen(0, () => {
      const client = net.connect(server.address().port, () => client.write(payload));
      client.on('error', reject);
    });
  });
}

async function main() {
  // Prove the recorder can fire BEFORE asserting it is empty. An assertion that a list is
  // empty is worthless if nothing could ever append to it — §6's "holds either way" shape.
  Shim.from('liveness-probe');
  assert.equal(touched.length, 1, 'the recorder must be live, or every check below is vacuous');
  touched.length = 0;

  assert.equal(
    await netRoundTrip('PAYLOAD'),
    'PAYLOAD',
    'net must not resolve Buffer through the shim',
  );
  // Covers the INBOUND direction too: net's `asBuffer` wraps every 'data' chunk, which is
  // the disclosure direction. Reverting only that read leaves the write assertion green.
  assert.deepEqual(touched, [], 'net must not reach the shim in either direction');

  // os.userInfo's buffer form re-read the export on EVERY call, so it is the strictest of
  // the four: no ordering trick is needed to steer it.
  touched.length = 0;
  const info = os.userInfo({ encoding: 'buffer' });
  assert.equal(RealBuffer.isBuffer(info.username), true);
  assert.equal(info.username.length > 0, true, 'username must be real bytes');
  // The recorder, not a corrupted value: os never passes the payload string, so checking
  // the RESULT cannot see the defect. What it must not do is reach the shim at all.
  assert.deepEqual(touched, [], 'os must not resolve Buffer through the mutable export');

  // --- MEMBER mutation, not just constructor replacement ---------------------------
  // Capturing `Buffer` alone is not enough: `.from` is read off it at CALL time, so
  // replacing the member steers a module holding a pristine constructor. Verified before
  // the loader captured the operations — node said "PAYLOAD", this said "TAMPERED".
  bufferModule.Buffer = RealBuffer;
  const realFrom = RealBuffer.from;
  RealBuffer.from = function (value, a, b) {
    if (value === 'PAYLOAD2') return realFrom.call(RealBuffer, 'TAMPERED');
    return realFrom.call(RealBuffer, value, a, b);
  };
  try {
    assert.equal(
      await netRoundTrip('PAYLOAD2'),
      'PAYLOAD2',
      'a replaced Buffer.from must not steer net either',
    );
  } finally {
    RealBuffer.from = realFrom;
  }

  // --- CALL-TIME reads, which a module-eval test cannot see -------------------------
  // os.userInfo originally re-read the live export on every call, so a case that only
  // swaps things BEFORE the first require would miss it entirely. Here os was required
  // long ago; only the member is replaced, and only now.
  const realFrom2 = RealBuffer.from;
  const callTime = [];
  RealBuffer.from = function (value, a, b) {
    callTime.push(typeof value === 'string' ? value.slice(0, 8) : typeof value);
    return realFrom2.call(RealBuffer, value, a, b);
  };
  try {
    const late = os.userInfo({ encoding: 'buffer' });
    assert.equal(RealBuffer.isBuffer(late.username), true);
    assert.deepEqual(callTime, [], 'os must not read Buffer.from at call time');
  } finally {
    RealBuffer.from = realFrom2;
  }

  // --- http: response body AND chunked request framing -------------------------------
  // http was migrated by this change and pinned by NOTHING until now: reverting one line in
  // http.js left every gate green while the divergence returned. Two phases, because they
  // fail differently — `from` corrupts the body, `concat`/`toString` corrupt the FRAMING.
  bufferModule.Buffer = Shim;
  touched.length = 0;
  assert.equal(
    await httpEcho('PAYLOAD', false),
    'PAYLOAD',
    'http response body must not be steered',
  );
  // NOT a `touched` assertion here, unlike net: node's own http reaches Buffer.from for
  // its status-line and CRLF constants ('HTTP/1.1 400', '\r\n'), so an empty-recorder
  // check fails on the ORACLE side. What must hold on both runtimes is that the PAYLOAD
  // is not steered — which is the property the migration actually buys.

  // A chunked POST split mid-size-line reaches Buffer.concat (reassembly) and the latin1
  // read of the size. Node frames HTTP in C and is unsteerable here; Lava must match.
  //
  // Both gadgets are installed for this phase only, and both are NARROW — a broad concat or
  // toString rewrites the test's own machinery. Without them the phase proved nothing: I
  // measured a live `Buffer.concat` and a live `Buffer.prototype.toString` both SURVIVING
  // an earlier version of this block.
  const realConcat = RealBuffer.concat;
  const realProtoToString = RealBuffer.prototype.toString;
  const realProtoSlice = RealBuffer.prototype.slice;
  // The cursor advance. `10\r\n` is 4 bytes, so a slice(4) that lands on 3 leaves a stray
  // byte and desynchronises every chunk after it.
  RealBuffer.prototype.slice = function (a, b) {
    // `b === undefined` rather than `arguments.length === 1`: an uncurried wrapper forwards
    // a trailing undefined, so an arity check silently never fires. That exact detail made
    // an earlier version of this gadget useless — the slice mutation survived it.
    if (b === undefined && a === 4) return realProtoSlice.call(this, 3);
    return realProtoSlice.call(this, a, b);
  };
  Shim.concat = function (list, total) {
    // Swap the two halves of the reassembly, which desynchronises the size line from
    // its body if the decoder resolves concat live.
    if (Array.isArray(list) && list.length === 2) return realConcat([list[1], list[0]], total);
    return realConcat(list, total);
  };
  RealBuffer.prototype.toString = function (enc, a, b) {
    const out = realProtoToString.call(this, enc, a, b);
    // '10' is the hex size of the second chunk; shrinking it to '1' truncates the body.
    return enc === 'latin1' && out === '10' ? '1' : out;
  };
  try {
    assert.equal(
      await httpEcho('AAAABBBBBBBBBBBBBBBB', true),
      'AAAABBBBBBBBBBBBBBBB',
      'http chunked framing must not be steered',
    );
  } finally {
    Shim.concat = realConcat;
    RealBuffer.prototype.toString = realProtoToString;
    RealBuffer.prototype.slice = realProtoSlice;
  }

  bufferModule.Buffer = Shim;
  // The shim is genuinely installed — otherwise every assertion above is vacuous.
  assert.equal(require('node:buffer').Buffer, Shim, 'the shim must still be in place');
  assert.equal(RealBuffer.from('PAYLOAD').toString(), 'PAYLOAD');
  assert.equal(Shim.from('PAYLOAD').toString(), 'TAMPERED', 'and it must still corrupt');

  bufferModule.Buffer = RealBuffer;
  console.log('ok');
}

main().then(
  () => {},
  (err) => {
    bufferModule.Buffer = RealBuffer;
    process.stdout.write('FAILED: ' + err.message + '\n');
    process.exitCode = 1;
  },
);
