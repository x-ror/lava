// http smoke client — always run under Node, against the echo server (server.js)
// running under either Node or Lava. Prints only DETERMINISTIC, semantic response
// fields (status, content-type, the echoed method, body) — not Date/Connection/header
// order, which legitimately differ between server runtimes — so the two server outputs
// compare equal. Connects to HTTP_PORT on 127.0.0.1.
const http = require('node:http');

const PORT = Number(process.env.HTTP_PORT);

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = body ? { 'Content-Length': Buffer.byteLength(body) } : {};
    const r = http.request(
      { host: '127.0.0.1', port: PORT, method: method, path: path, headers: headers },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (b += d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            ct: res.headers['content-type'],
            xm: res.headers['x-echo-method'],
            body: b,
          }),
        );
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// POST a body with no Content-Length so the Node http client frames it with
// Transfer-Encoding: chunked — exercises the server's chunked-request decoder.
function requestChunked(path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: path }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

(async () => {
  const g = await request('GET', '/path/one');
  console.log('GET', g.status, g.ct, g.xm, JSON.stringify(g.body));

  const p = await request('POST', '/submit', 'hello-body-42');
  console.log('POST', p.status, p.xm, JSON.stringify(p.body));

  const q = await request('GET', '/q?a=1&b=2');
  console.log('QUERY', q.status, JSON.stringify(q.body));

  // Streamed (chunked) response — the http client decodes Transfer-Encoding: chunked
  // transparently, so the assembled body must match between the Node and Lava servers.
  const s = await request('GET', '/stream');
  console.log('STREAM', s.status, JSON.stringify(s.body));

  // Chunked REQUEST: writing a body without setting Content-Length makes the Node http
  // client send Transfer-Encoding: chunked. Both servers must decode it to the same echo.
  const ch = await requestChunked('/chunk', 'chunked-body-xyz');
  console.log('CHUNKEDREQ', ch.status, JSON.stringify(ch.body));

  console.log('HTTP SMOKE OK');
})().catch((e) => {
  console.error('client error', e && e.message);
  process.exit(1);
});
