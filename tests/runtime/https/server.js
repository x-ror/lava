// HTTPS server fixture for the https smoke test (scripts/run-https-smoke.sh). Reads its
// PEM key+cert from TLS_KEY/TLS_CERT, prints READYPORT=<port> once listening, and serves:
//   POST /e<n>  → echoes "echo:<method>:<url>:<body>" with an X-Secure header from
//                 req.socket.encrypted (proves the TLS transport classified the request)
//   GET  /big   → a 2 MiB deterministic body (exercises chunked TLS writes + backpressure)
// Run under Lava (the smoke also drives it with LAVA_NET_FORCE_READINESS for the readiness path).
const fs = require('fs');
const https = require('https');

const key = fs.readFileSync(process.env.TLS_KEY);
const cert = fs.readFileSync(process.env.TLS_CERT);

const BIG = 2 * 1024 * 1024;
const bigBuf = Buffer.alloc(BIG);
for (let i = 0; i < BIG; i++) bigBuf[i] = (i * 31 + 7) & 0xff;

const server = https.createServer({ key, cert }, (req, res) => {
  // Socket-level instrumentation for the single-'end' test (T2): log a SOCKETEND line for EACH
  // net.Socket 'end'. A graceful TLS close (the client's close_notify then FIN) must fire 'end'
  // EXACTLY once — the readiness double-'end' regression (M2) shows up as two lines for one
  // connection. Hooked via req.socket (lava's http.Server doesn't re-emit 'connection'), guarded so
  // a kept-alive socket serving N requests attaches the listener once. Inert for other phases.
  if (!req.socket._endHooked) {
    req.socket._endHooked = true;
    req.socket.on('end', () => console.log('SOCKETEND'));
  }
  if (req.url === '/big') {
    res.writeHead(200, { 'Content-Length': String(BIG) });
    res.end(bigBuf);
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      'X-Secure': String(!!req.socket.encrypted),
    });
    res.end('echo:' + req.method + ':' + req.url + ':' + body);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log('READYPORT=' + server.address().port);
});
