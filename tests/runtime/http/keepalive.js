// http keep-alive checks — run under Node against the Lava HTTP server
// (run-http-smoke.sh phase 3). Drives MULTIPLE request/response round-trips over a SINGLE
// socket to exercise connection reuse, pipelining, Connection: close, the carried-over
// leftover after a body, and HTTP/1.0's default-close. Lava-specific behavior, so it is a
// pass/fail assertion suite (not a node-vs-lava diff). Connects to HTTP_PORT on 127.0.0.1.
const net = require('net');

const PORT = Number(process.env.HTTP_PORT);

// Open one socket, send `reqs` (each a raw request string) one at a time — sending the
// next only after a full response is parsed — and resolve with the array of responses.
// Responses are framed by Content-Length (the echo fixture always sets it).
function session(reqs) {
  return new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1');
    let buf = '';
    const got = [];
    let idx = 0;
    c.on('connect', () => c.write(Buffer.from(reqs[idx++], 'latin1')));
    c.on('data', (d) => {
      buf += d.toString('latin1');
      let m;
      while ((m = buf.match(/^HTTP\/1\.1 \d{3}[^\r]*\r\n([\s\S]*?)\r\n\r\n/))) {
        const head = m[0];
        const clm = head.match(/content-length:\s*(\d+)/i);
        const cl = clm ? Number(clm[1]) : 0;
        const need = head.length + cl;
        if (buf.length < need) break;
        got.push(buf.slice(0, need));
        buf = buf.slice(need);
        if (idx < reqs.length) c.write(Buffer.from(reqs[idx++], 'latin1'));
      }
    });
    c.on('close', () => resolve(got));
    c.on('error', () => resolve(got));
    setTimeout(() => c.destroy(), 4000);
  });
}

const statusOf = (r) => {
  const m = (r || '').match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : 0;
};
const hasKeepAlive = (r) => /connection:\s*keep-alive/i.test(r || '');
const hasClose = (r) => /connection:\s*close/i.test(r || '');

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
  // 1. Two sequential requests reuse one socket; the first advertises keep-alive.
  let g = await session([
    'GET /a HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET /b HTTP/1.1\r\nHost: x\r\n\r\n',
  ]);
  check(
    'keepalive-sequential',
    g.length === 2 &&
      statusOf(g[0]) === 200 &&
      statusOf(g[1]) === 200 &&
      / U=\/a /.test(g[0]) &&
      / U=\/b /.test(g[1]),
    g.length + ' responses',
  );
  check('keepalive-conn-header', hasKeepAlive(g[0]), (g[0] || '').slice(0, 60));

  // 2. Pipelined requests (both in one write) are answered in order.
  g = await session(['GET /p1 HTTP/1.1\r\nHost: x\r\n\r\nGET /p2 HTTP/1.1\r\nHost: x\r\n\r\n']);
  check(
    'pipelined-two',
    g.length === 2 && / U=\/p1 /.test(g[0]) && / U=\/p2 /.test(g[1]),
    g.length + ' responses',
  );

  // 3. Connection: close → exactly one response (the trailing request is not served).
  g = await session([
    'GET /c HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\nGET /never HTTP/1.1\r\nHost: x\r\n\r\n',
  ]);
  check('connection-close-one', g.length === 1 && hasClose(g[0]), g.length + ' responses');

  // 4. A Content-Length body is consumed, and the bytes after it are parsed as the next
  //    request on the same socket (leftover carried over).
  g = await session([
    'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n\r\nabcGET /y HTTP/1.1\r\nHost: x\r\n\r\n',
  ]);
  check(
    'clbody-then-reuse',
    g.length === 2 && /B=abc\b/.test(g[0]) && / U=\/y /.test(g[1]),
    g.length + ' responses',
  );

  // 5. HTTP/1.0 defaults to close → one response.
  g = await session(['GET /h HTTP/1.0\r\nHost: x\r\n\r\nGET /never HTTP/1.0\r\nHost: x\r\n\r\n']);
  check('http10-default-close', g.length === 1, g.length + ' responses');

  console.log(failures === 0 ? 'HTTP KEEPALIVE OK' : 'HTTP KEEPALIVE FAILURES ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
