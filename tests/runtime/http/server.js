// http smoke fixture: an echo HTTP/1.1 server. Run under BOTH Node and Lava by
// scripts/run-http-smoke.sh; the same Node client (client.js) hits each and the
// deterministic response fields (status, chosen headers, body) must match. Binds an
// ephemeral port and prints it as READYPORT=<port>. Echoes method, url, and body.
const http = require('node:http');

// Short timeouts for the slowloris phase (run-http-smoke.sh phase 4), passed via the
// createServer(options) form so that construction-time config path is exercised too; off
// by default so the other phases use Node's normal multi-second timeouts.
const opts = process.env.HTTP_SHORT_TIMEOUTS
  ? { keepAliveTimeout: 250, headersTimeout: 250, requestTimeout: 400 }
  : {};

const server = http.createServer(opts, (req, res) => {
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
  // /stream writes the body in pieces via write()+end() with no Content-Length, so the
  // runtime must frame it with Transfer-Encoding: chunked. The parity client checks the
  // assembled body; phase 2 checks the chunk framing on the wire.
  if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('part1-');
    res.write('part2-');
    res.end('part3');
    return;
  }
  // /status/<code> writes a status derived from the (decoded) URL — the status-line
  // injection sink + no-body-status check (run-http-smoke.sh phase 2).
  if (req.url.indexOf('/status/') === 0) {
    try {
      res.writeHead(decodeURIComponent(req.url.slice('/status/'.length)));
      res.end('body');
    } catch (e) {
      res.writeHead(500);
      res.end('BADSTATUS ' + e.code);
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
    // P= echoes back a probe request header (its decoded char codes) when present — used
    // by the latin1 round-trip check. Absent for the parity client, so its output is
    // unchanged.
    var probe = req.headers['x-probe'];
    var p =
      probe === undefined
        ? ''
        : ' P=' +
          Array.from(probe)
            .map((c) => c.charCodeAt(0))
            .join(',');
    res.end('M=' + req.method + ' U=' + req.url + ' L=' + body.length + ' B=' + body + p);
  });
});

server.on('error', (e) => {
  console.error('server error', e && e.message);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  console.log('READYPORT=' + server.address().port);
});
