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
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Chunked (no explicit Content-Length) — exercises de-chunking.
      res.end(JSON.stringify({ method: req.method, echo: body, len: body.length }));
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

http.createServer(handler).listen(port, '127.0.0.1');
// IPv6 loopback listener on the same port (a distinct address/family tuple), so
// the smoke suite can exercise http://[::1]:<port>/ when IPv6 is available. A
// bind failure on hosts without IPv6 loopback is ignored — the runner probes
// reachability before enabling the IPv6 case.
const server6 = http.createServer(handler);
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
