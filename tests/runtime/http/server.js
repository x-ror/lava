// http smoke fixture: an echo HTTP/1.1 server. Run under BOTH Node and Lava by
// scripts/run-http-smoke.sh; the same Node client (client.js) hits each and the
// deterministic response fields (status, chosen headers, body) must match. Binds an
// ephemeral port and prints it as READYPORT=<port>. Echoes method, url, and body.
const http = require('node:http');

const server = http.createServer((req, res) => {
  // /redir reflects the (decoded) URL into a Location header — the canonical header-
  // injection sink, used by the malformed-request checks (run-http-smoke.sh phase 2).
  if (req.url.indexOf('/redir') === 0) {
    try {
      res.setHeader('Location', decodeURIComponent(req.url));
      res.writeHead(302);
      res.end('r');
    } catch (e) {
      res.writeHead(500);
      res.end('REJECTED ' + e.code);
    }
    return;
  }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Echo-Method': req.method,
    });
    res.end('M=' + req.method + ' U=' + req.url + ' L=' + body.length + ' B=' + body);
  });
});

server.on('error', (e) => {
  console.error('server error', e && e.message);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  console.log('READYPORT=' + server.address().port);
});
