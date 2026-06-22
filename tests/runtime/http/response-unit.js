// Unit tests for ServerResponse head/body coalescing (PR #283). Run UNDER Lava:
//   lava run tests/runtime/http/response-unit.js
// Constructs a ServerResponse over a mock socket that records every write, and asserts the
// coalescing fast path, its size bound (head + body), the non-coalescing paths (large
// header/body, chunked, HEAD), and that a non-Uint8Array body never leaves the response
// marked sent without the head actually written. Exits non-zero on the first failure.
const http = require('node:http');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    failures++;
  }
}
function mockSocket() {
  const s = { writes: [], ended: false };
  s.write = function (buf) {
    s.writes.push(Buffer.from(buf)); // copy: capture bytes at write time
    return true;
  };
  s.end = function () {
    s.ended = true;
  };
  return s;
}
function bytes(s) {
  return Buffer.concat(s.writes);
}

// 1) Small known body → ONE coalesced write, head + body in order.
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.writeHead(200, { 'Content-Length': '5' });
  res.end('hello');
  check(s.writes.length === 1, '1: expected 1 coalesced write, got ' + s.writes.length);
  const b = bytes(s).toString('latin1');
  check(b.indexOf('HTTP/1.1 200') === 0, '1: status line present');
  check(b.indexOf('Content-Length: 5') !== -1, '1: content-length present');
  check(b.endsWith('\r\n\r\nhello'), '1: body coalesced after head');
})();

// 2) Large header + tiny body → combined size exceeds the bound → NOT coalesced (2 writes),
//    bytes still correct. Guards against the head being unbounded in the merged buffer.
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.setHeader('X-Big', 'a'.repeat(70000));
  res.writeHead(200, { 'Content-Length': '2' });
  res.end('ok');
  check(s.writes.length === 2, '2: large header must not coalesce, got ' + s.writes.length);
  const b = bytes(s).toString('latin1');
  check(b.indexOf('X-Big: ' + 'a'.repeat(70000)) !== -1, '2: big header intact');
  check(b.endsWith('\r\n\r\nok'), '2: body after head');
})();

// 3) Large body (> bound) → NOT coalesced (no giant memcpy onto the head), bytes correct.
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  const big = Buffer.alloc(70000, 0x61);
  res.writeHead(200, { 'Content-Length': String(big.length) });
  res.end(big);
  check(s.writes.length === 2, '3: large body must not coalesce, got ' + s.writes.length);
  const b = bytes(s);
  check(b.length === s.writes[0].length + 70000, '3: total bytes = head + body');
  check(b.slice(-70000).equals(big), '3: body bytes intact');
})();

// 4) Uint8Array body → coalesced, byte-exact (length == byteLength for Uint8Array).
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.writeHead(200, { 'Content-Length': '2' });
  res.end(new Uint8Array([104, 105])); // "hi"
  check(s.writes.length === 1, '4: Uint8Array body coalesced, got ' + s.writes.length);
  check(bytes(s).slice(-2).toString('latin1') === 'hi', '4: Uint8Array bytes');
})();

// 5) HEAD → headers only, no body bytes (still one write: head, body suppressed).
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'HEAD', 1);
  res.writeHead(200, { 'Content-Length': '5' });
  res.end('hello');
  const b = bytes(s).toString('latin1');
  check(b.indexOf('Content-Length: 5') !== -1, '5: HEAD keeps Content-Length');
  check(b.indexOf('hello') === -1, '5: HEAD sends no body');
})();

// 6) Non-Uint8Array body (e.g. Uint16Array) → takes the separate path, never the throwing
//    coalesce. The head must still be written and headersSent reflect reality (the bug was
//    marking sent before a throwing concat, leaving zero bytes written).
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.writeHead(200, { 'Content-Length': '2' });
  let threw = false;
  try {
    res.end(new Uint16Array([0x6968]));
  } catch (e) {
    threw = true;
  }
  check(!threw, '6: non-Uint8Array body takes the separate path, does not throw');
  check(res.finished === true, '6: response finished');
  check(res.headersSent === true, '6: headersSent set');
  check(s.writes.length >= 1, '6: head was actually written (not falsely marked sent)');
  check(bytes(s).toString('latin1').indexOf('HTTP/1.1 200') === 0, '6: head present');
})();

// 7) Streamed (write before end) → chunked framing on its own path, not coalesced.
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.writeHead(200, {});
  res.write('part');
  res.end('done');
  const b = bytes(s).toString('latin1');
  check(b.indexOf('Transfer-Encoding: chunked') !== -1, '7: chunked header');
  check(b.indexOf('0\r\n\r\n') !== -1, '7: last-chunk terminator');
})();

// 8) A head-serialization failure must NOT mark the response sent (headersSent is flipped
//    only after the head buffer is built). Force _buildHead to throw via an out-of-range
//    status assigned directly (bypassing writeHead's own validation).
(function () {
  const s = mockSocket();
  const res = new http.ServerResponse(s, 'GET', 1);
  res.statusCode = 99999; // invalid; validateStatusCode throws inside _buildHead
  let threw = false;
  try {
    res.end('x');
  } catch (e) {
    threw = true;
  }
  check(threw, '8: invalid status throws');
  check(res.headersSent === false, '8: headersSent stays false on a build failure');
  check(s.writes.length === 0, '8: nothing written on a build failure');
})();

// 9) Coalesce bound is on the COMBINED size. A body at exactly HEAD_COALESCE_MAX makes
//    total > the bound (head + body) → separate writes; well under → one write.
(function () {
  const MAX = 64 * 1024;
  const s1 = mockSocket();
  const r1 = new http.ServerResponse(s1, 'GET', 1);
  const atMax = Buffer.alloc(MAX, 0x62);
  r1.writeHead(200, { 'Content-Length': String(atMax.length) });
  r1.end(atMax);
  check(s1.writes.length === 2, '9: body == MAX (head pushes total over) → not coalesced');
  check(bytes(s1).length === s1.writes[0].length + MAX, '9: bytes = head + body');

  const s2 = mockSocket();
  const r2 = new http.ServerResponse(s2, 'GET', 1);
  const under = Buffer.alloc(MAX - 1024, 0x63);
  r2.writeHead(200, { 'Content-Length': String(under.length) });
  r2.end(under);
  check(s2.writes.length === 1, '9: body comfortably under bound → coalesced');
})();

// 10) Prototype pollution of the public Buffer/Uint8Array methods the old path used must not
//     corrupt the head or leak uninitialized bytes past the body — the head/body are now
//     serialized with pristine primordials. Reassemble via pristine index reads.
(function () {
  const _fromCharCode = String.fromCharCode; // capture before polluting
  const origAlloc = Buffer.allocUnsafe;
  const origWrite = Buffer.prototype.write;
  const origSet = Uint8Array.prototype.set;
  Buffer.allocUnsafe = function (n) {
    return origAlloc(n + 8); // oversized: would leak 8 trailing bytes if used
  };
  Buffer.prototype.write = function () {
    return 0; // no-op: would blank the head if used
  };
  Uint8Array.prototype.set = function () {}; // no-op: would blank the body if used
  try {
    const s = { raw: [], write: (b) => (s.raw.push(b), true), end() {} };
    const res = new http.ServerResponse(s, 'GET', 1);
    res.writeHead(200, { 'Content-Length': '5' });
    // Pre-made Uint8Array body (no Buffer.from(string) conversion) so this isolates the head
    // serialization + coalesce — the path this fix made pristine — from the separate,
    // pre-existing string→bytes conversion.
    res.end(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])); // "hello"
    let out = '';
    for (const buf of s.raw) for (let i = 0; i < buf.length; i++) out += _fromCharCode(buf[i]);
    check(out.indexOf('HTTP/1.1 200') === 0, '10: head intact under pollution');
    check(out.endsWith('\r\n\r\nhello'), '10: body intact + no trailing leak under pollution');
  } finally {
    Buffer.allocUnsafe = origAlloc;
    Buffer.prototype.write = origWrite;
    Uint8Array.prototype.set = origSet;
  }
})();

if (failures > 0) {
  console.error('response-unit: ' + failures + ' failure(s)');
  process.exit(1);
}
console.log('RESPONSE UNIT OK');
