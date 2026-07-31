// http malformed-request checks — run under Node against the Lava HTTP server
// (run-http-smoke.sh phase 2). Unlike the parity client, these assert Lava's OWN
// handling of untrusted/malformed input (header injection, request smuggling vectors,
// oversized head, HEAD body, premature EOF), so they are not a node-vs-lava diff. Sends
// crafted raw bytes over a socket and checks the response status line. Exit non-zero on
// any failure. Connects to HTTP_PORT on 127.0.0.1.
const net = require('net');

const PORT = Number(process.env.HTTP_PORT);

function raw(bytes, halfCloseAfterWrite) {
  return new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1', () => {
      // latin1 so each char maps to one raw byte (ASCII unchanged; lets us put a raw 0xE9
      // on the wire). The default string write would UTF-8-encode it.
      c.write(Buffer.from(bytes, 'latin1'));
      if (halfCloseAfterWrite) c.end();
    });
    let buf = Buffer.alloc(0);
    c.on('data', (d) => (buf = Buffer.concat([buf, d])));
    c.on('close', () => resolve(buf.toString('latin1')));
    c.on('error', () => resolve(buf.toString('latin1')));
    setTimeout(() => c.destroy(), 4000); // safety: never hang the suite
  });
}

const statusOf = (r) => {
  const m = r.match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : 0;
};
const bodyOf = (r) => {
  const i = r.indexOf('\r\n\r\n');
  return i < 0 ? '' : r.slice(i + 4);
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log('PASS', name);
  } else {
    failures++;
    console.log('FAIL', name, detail || '');
  }
}

(async () => {
  // 1. CRLF header injection via a reflected Location must be rejected, not split.
  let r = await raw(
    'GET /redir%0d%0aInjected:%20yes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  );
  check('injection-rejected-500', statusOf(r) === 500, r.slice(0, 40));
  check('injection-no-split-header', !/Injected:/i.test(r));

  // 1b. CRLF in a header NAME (isHttpToken), not only the value path.
  // Under HTTP_POISON_REGEXP=charcodeat a live charCodeAt would accept the name and
  // write real CR/LF onto the response head.
  r = await raw('GET /set-name/a%0d%0aInjected HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('injection-name-rejected-500', statusOf(r) === 500, r.slice(0, 40));
  // Server route embeds e.code; require the real isHttpToken error, not a generic 500.
  check(
    'injection-name-code',
    bodyOf(r).includes('REJECTED ERR_INVALID_HTTP_TOKEN'),
    bodyOf(r).slice(0, 60),
  );
  check('injection-name-no-split', !/Injected:/i.test(r));

  // 1c. Content-Length conversion must use the real digit value, not a poisoned
  // parseInt. Body is exactly 3 bytes; a gadget returning 7 would either hang
  // waiting for 4 more or, with a pipelined second request, swallow it as body.
  // Under HTTP_POISON_REGEXP=parseint this is the conversion pin; unpoisoned it is
  // just a framing sanity check.
  r = await raw('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc');
  check(
    'content-length-framing-3',
    statusOf(r) === 200 && /L=3 B=abc\b/.test(r),
    bodyOf(r).slice(0, 60),
  );

  // 2. Content-Length + Transfer-Encoding together (CL.TE smuggling desync) -> 400.
  r = await raw(
    'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nhello',
  );
  check('cl-plus-te-400', statusOf(r) === 400, r.slice(0, 40));

  // 3. Non-numeric / duplicate / negative Content-Length -> 400.
  r = await raw('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\nConnection: close\r\n\r\n');
  check('bad-content-length-400', statusOf(r) === 400, r.slice(0, 40));

  // 4. Oversized request head -> 431.
  r = await raw(
    'GET / HTTP/1.1\r\nHost: x\r\nX-Big: ' +
      'a'.repeat(70 * 1024) +
      '\r\nConnection: close\r\n\r\n',
  );
  check('oversized-head-431', statusOf(r) === 431, r.slice(0, 40));

  // 5. HEAD response: headers (200) but no body.
  r = await raw('HEAD / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('head-status-200', statusOf(r) === 200, r.slice(0, 40));
  check('head-no-body', bodyOf(r) === '', JSON.stringify(bodyOf(r)));

  // 6. Premature EOF mid-head -> 400.
  r = await raw('GET /incomplete HTTP/1.1\r\nHost: x\r\n', true);
  check('premature-eof-400', statusOf(r) === 400, r.slice(0, 40) || '(closed empty)');

  // 7. High-code-point injection: U+010D/U+010A latin1-mask to CR/LF. The reflected value
  //    must be rejected (500), not split into headers. (%C4%8D%C4%8A decodes to čĊ.)
  r = await raw(
    'GET /redir%C4%8D%C4%8AInjected:%20yes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  );
  check('highcp-injection-rejected', statusOf(r) === 500 && !/Injected:/i.test(r), r.slice(0, 40));

  // 8. Status-line injection: writeHead('200\r\nX-Injected: yes') must be rejected (500),
  //    not inject a header. (%0d%0a decodes to CRLF inside the status argument.)
  r = await raw(
    'GET /status/200%0d%0aX-Injected:%20yes HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  );
  check(
    'status-injection-rejected',
    statusOf(r) === 500 && !/X-Injected:/i.test(r),
    r.slice(0, 40),
  );

  // 9. No-body status: 204 must carry no body and no Content-Length even when end(chunk)
  //    is called.
  r = await raw('GET /status/204 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check(
    'no-body-204',
    statusOf(r) === 204 && bodyOf(r) === '' && !/content-length/i.test(r),
    r.slice(0, 60),
  );

  // 10. Latin-1 header bytes: a raw 0xE9 in a header value must reach the server as the
  //     single char U+00E9 (Node decodes HTTP/1 headers as latin1), not mangled UTF-8.
  r = await raw('GET / HTTP/1.1\r\nHost: x\r\nX-Probe: \xe9\r\nConnection: close\r\n\r\n');
  check('latin1-header', /P=233\b/.test(r), r.slice(0, 80));

  // 11. Streamed response must be chunk-framed on the wire: Transfer-Encoding: chunked
  //     header, a "6\r\npart1-\r\n" chunk, and the "0\r\n\r\n" terminator — and NO
  //     Content-Length.
  r = await raw('GET /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check(
    'chunked-response-framing',
    /transfer-encoding:\s*chunked/i.test(r) &&
      /\r\n6\r\npart1-\r\n/.test(r) &&
      r.endsWith('0\r\n\r\n') &&
      !/content-length/i.test(r),
    r.slice(0, 60),
  );

  // 12. HTTP/1.0 streamed response must NOT be chunked (1.0 has no Transfer-Encoding) —
  //     raw, close-delimited body. The chunk markers must be absent and the body intact.
  r = await raw('GET /stream HTTP/1.0\r\nHost: x\r\nConnection: close\r\n\r\n');
  check(
    'http10-no-chunked',
    !/transfer-encoding/i.test(r) && bodyOf(r) === 'part1-part2-part3',
    JSON.stringify(bodyOf(r)),
  );

  // 13. Chunked REQUEST body is decoded and delivered to the handler (echo reports its
  //     decoded length + bytes). "5 hello" + "6  world" => 11 bytes "hello world".
  r = await raw(
    'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n',
  );
  check(
    'chunked-request-decoded',
    statusOf(r) === 200 && /L=11 B=hello world\b/.test(r),
    bodyOf(r).slice(0, 60),
  );

  // 14. Transfer-Encoding present but not "chunked" (e.g. gzip) -> 501 (unsupported coding).
  r = await raw(
    'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: gzip\r\nConnection: close\r\n\r\n',
  );
  check('te-not-chunked-501', statusOf(r) === 501, r.slice(0, 40));

  // 15. Malformed chunk size (non-hex) in a chunked body -> 400.
  r = await raw(
    'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nZZ\r\nhello\r\n0\r\n\r\n',
  );
  check('bad-chunk-size-400', statusOf(r) === 400, r.slice(0, 40));

  // Strict chunk grammar (smuggling-resistance): reject whitespace around the size and an
  // empty/garbage extension, but still accept a valid extension and a valid trailer.
  var CHUNKED =
    'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n';
  // 16. Whitespace in the chunk-size token -> 400.
  r = await raw(CHUNKED + '5 \r\nhello\r\n0\r\n\r\n');
  check('chunk-size-whitespace-400', statusOf(r) === 400, r.slice(0, 40));
  // 17. Empty chunk extension ("5;") -> 400.
  r = await raw(CHUNKED + '5;\r\nhello\r\n0\r\n\r\n');
  check('empty-chunk-ext-400', statusOf(r) === 400, r.slice(0, 40));
  // 18. Garbage trailer line ("BadTrailer", no colon) -> 400.
  r = await raw(CHUNKED + '0\r\nBadTrailer\r\n\r\n');
  check('bad-trailer-400', statusOf(r) === 400, r.slice(0, 40));
  // 19. Over-long chunk-size/extension line (> 64 KiB) even with a CRLF -> 400.
  r = await raw(CHUNKED + '5;' + 'a'.repeat(70 * 1024) + '\r\nhello\r\n0\r\n\r\n');
  check('overlong-chunk-line-400', statusOf(r) === 400, r.slice(0, 40));
  // 20. A valid chunk extension and trailer must still be accepted (no over-rejection).
  r = await raw(CHUNKED + '5;name=val\r\nhello\r\n0\r\nX-Trailer: ok\r\n\r\n');
  check(
    'valid-ext-and-trailer-200',
    statusOf(r) === 200 && /L=5 B=hello\b/.test(r),
    r.slice(0, 60),
  );

  console.log(failures === 0 ? 'HTTP MALFORMED OK' : 'HTTP MALFORMED FAILURES ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
