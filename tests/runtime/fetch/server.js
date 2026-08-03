// Tiny HTTP origin server for the fetch smoke test. Run under Node:
//   node tests/runtime/fetch/server.js [port]
// Exercises both Content-Length and chunked framing, plus POST body echo, so
// the Lava transport is compared against Node over a real socket.
//
// When LAVA_TLS_CERT/LAVA_TLS_KEY are set it also starts an HTTPS listener on
// LAVA_TLS_PORT (same request handler), so the suite can exercise the TLS
// transport against a self-signed cert (see scripts/run-fetch-smoke.sh).
const http = require('node:http');

const port = Number(process.argv[2] || 8799);

const handler = (req, res) => {
  // Worktree isolation (agent-cycle F2): readiness probe matches FETCH_SMOKE_NONCE
  // so a parallel smoke never green-passes against a foreign origin on the same port.
  if (req.url === '/_lava_ready') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(process.env.FETCH_SMOKE_NONCE || 'no-nonce');
    return;
  }
  // Redirect / Set-Cookie routes are dispatched before the generic POST echo so
  // a POST can receive a 3xx response (the client then re-issues per the redirect
  // rules) rather than being echoed. Exercises HTTP correctness (issue #99).
  switch (req.url) {
    case '/redirect':
      // Absolute-path Location, followed by default redirect: 'follow'.
      res.writeHead(302, { Location: '/a' });
      res.end('moved');
      return;
    case '/redirect-rel':
      // Relative Location ("a") resolved against the request URL.
      res.writeHead(302, { Location: 'a' });
      res.end('moved');
      return;
    case '/redirect-303':
      // 303 turns any POST into a GET and drops the body.
      res.writeHead(303, { Location: '/a' });
      res.end('see other');
      return;
    case '/redirect-307':
      // 307 preserves the method and resends the body (to the POST echo).
      res.writeHead(307, { Location: '/echo' });
      res.end('keep');
      return;
    case '/redirect-loop':
      // Self-referential redirect: the client must bound the hop count.
      res.writeHead(302, { Location: '/redirect-loop' });
      res.end('loop');
      return;
    case '/set-cookies':
      // Multiple Set-Cookie headers, one with a comma inside its Expires= date —
      // they must survive as distinct cookies (getSetCookie), not be comma-joined.
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['a=1', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'c=3'],
      });
      res.end('cookies');
      return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Chunked (no explicit Content-Length) — exercises de-chunking. Echo the
      // request body framing (te/cl) so the client can assert chunked-upload vs
      // Content-Length framing. (Chunk counts/sizes are NOT echoed: chunk
      // boundaries legitimately differ between runtimes and would break the
      // node-vs-lava output comparison.)
      res.end(
        JSON.stringify({
          method: req.method,
          echo: body,
          len: body.length,
          te: req.headers['transfer-encoding'] || null,
          cl: req.headers['content-length'] || null,
        }),
      );
    });
    return;
  }

  switch (req.url) {
    case '/host':
      // Echo the request's Host header so the IPv6 case can assert the client
      // re-bracketed the literal (Host: [::1]:<port>) per RFC 7230.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host }));
      return;
    case '/hello.txt':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('plain text body line\n');
      return;
    case '/data.json': {
      const payload = JSON.stringify({ hello: 'world', n: 42 });
      // Explicit Content-Length framing.
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }
    case '/utf8':
      // Multi-byte UTF-8 — exercises correct text() decoding (not latin1).
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('café ☕ 日本語\n');
      return;
    case '/big':
      // Large body via chunked framing (no Content-Length) — exercises
      // incremental de-chunking and response-body backpressure at scale. The
      // payload is deterministic so the client can recompute and compare it.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(200000));
      return;
    case '/big-cl': {
      // Large body with explicit Content-Length — exercises identity-framed
      // incremental streaming + backpressure.
      const big = 'y'.repeat(200000);
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(big),
      });
      res.end(big);
      return;
    }
    case '/empty':
      // 204 No Content — the response carries no body (response.body === null).
      res.writeHead(204);
      res.end();
      return;
    case '/slowbody':
      // Send the head and one body chunk, then hold the connection open forever.
      // Lets a client read part of the body and then abort — deterministically
      // exercising abort-after-headers (the body never completes on its own).
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      return;
    case '/badchunk': {
      // Hijack the socket to emit a chunked body whose chunk data is followed by
      // a non-CRLF terminator — a framing violation a client must reject. Written
      // raw because the http module always frames chunks correctly.
      const sock = res.socket;
      if (sock) {
        sock.write(
          'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        sock.write('5\r\nhelloXX'); // "XX" where the chunk-terminating CRLF must be
        setTimeout(() => sock.destroy(), 15);
      }
      return;
    }
    case '/truncate':
      // Declare a Content-Length far longer than the bytes actually sent, then
      // drop the connection — a truncated body the client must surface as an
      // error (Node: TypeError) once it tries to read past what arrived.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      res.write('partial-body');
      setTimeout(() => {
        if (res.socket) res.socket.destroy();
      }, 15);
      return;
    case '/a':
      res.writeHead(200);
      res.end('AAA');
      return;
    case '/b':
      res.writeHead(200);
      res.end('BBB');
      return;
    case '/c':
      res.writeHead(200);
      res.end('CCC');
      return;
    case '/never':
      // Accept the connection but never respond — used to test AbortSignal /
      // timeout behaviour. The server holds the socket open indefinitely.
      return;
    default:
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
  }
};

// guardSockets swallows per-connection socket errors. The /truncate route and the
// client-side reader.cancel() both drop connections mid-response, which raises an
// ECONNRESET on the server socket; without a handler that would crash the server
// process and fail the smoke run.
const guardSockets = (server) => {
  server.on('connection', (sock) => sock.on('error', () => {}));
  server.on('clientError', () => {});
  return server;
};

guardSockets(http.createServer(handler)).listen(port, '127.0.0.1');
// IPv6 loopback listener on the same port (a distinct address/family tuple), so
// the smoke suite can exercise http://[::1]:<port>/ when IPv6 is available. A
// bind failure on hosts without IPv6 loopback is ignored — the runner probes
// reachability before enabling the IPv6 case.
const server6 = guardSockets(http.createServer(handler));
server6.on('error', () => {});
server6.listen(port, '::1');

// Optional HTTPS listener for the TLS transport case. Only started when the
// runner has generated a cert/key and points LAVA_TLS_* at them.
if (process.env.LAVA_TLS_CERT && process.env.LAVA_TLS_KEY) {
  const fs = require('node:fs');
  const https = require('node:https');
  const tlsPort = Number(process.env.LAVA_TLS_PORT || port + 1);
  const tlsServer = https.createServer(
    {
      cert: fs.readFileSync(process.env.LAVA_TLS_CERT),
      key: fs.readFileSync(process.env.LAVA_TLS_KEY),
    },
    handler,
  );
  tlsServer.on('error', () => {});
  tlsServer.listen(tlsPort, '127.0.0.1');

  // Optional second HTTPS listener presenting a cert whose SAN does NOT cover
  // 127.0.0.1 (but is signed/trusted via the same CA bundle), so the suite can
  // prove the client rejects a hostname mismatch rather than a mere untrusted
  // cert. Started only when the runner provides the mismatched cert/key.
  if (process.env.LAVA_TLS_BADCERT && process.env.LAVA_TLS_BADKEY) {
    const badPort = Number(process.env.LAVA_TLS_BADPORT || tlsPort + 1);
    const badServer = https.createServer(
      {
        cert: fs.readFileSync(process.env.LAVA_TLS_BADCERT),
        key: fs.readFileSync(process.env.LAVA_TLS_BADKEY),
      },
      handler,
    );
    badServer.on('error', () => {});
    badServer.listen(badPort, '127.0.0.1');
  }
}
