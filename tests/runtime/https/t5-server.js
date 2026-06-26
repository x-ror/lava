// T5 fixture: a server that calls server.close() WHILE a keep-alive TLS connection is still live.
// This frees the per-listener SSL_CTX while the connection's own SSL is still in use — the
// refcount-safe path the design claims (SSL_CTX is refcounted; SSL_new took a ref). If it weren't
// safe, the live connection's next decrypt/encrypt (request #2) would crash/UAF. The server prints
// CLOSE-PENDING when it stops accepting and CLOSED-CLEAN when its 'close' finally fires (after the
// live connection ends), then exits 0 — a clean exit is itself proof of no UAF.
const fs = require('fs');
const https = require('https');

const server = https.createServer(
  { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) },
  (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('echo:' + req.method + ':' + req.url + ':' + body);
      // After serving the FIRST request, stop accepting new connections while THIS one stays live.
      if (req.url === '/first') {
        setImmediate(() => {
          console.log('CLOSE-PENDING');
          server.close(() => {
            console.log('CLOSED-CLEAN');
          });
        });
      }
    });
  },
);

server.listen(0, '127.0.0.1', () => {
  console.log('READYPORT=' + server.address().port);
});
