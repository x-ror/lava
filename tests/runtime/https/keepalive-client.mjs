// Keep-alive HTTPS client (Node) for the smoke's keep-alive phase. Lava's fetch sends
// Connection: close, so it can't reuse a TLS session — this Node client does, with a keepAlive
// Agent pinned to one socket. It issues 3 requests, asserts each response is byte-correct AND that
// all 3 reused the SAME socket (one TLS handshake), then closes the connection gracefully so the
// server's single-'end' assertion (SOCKETEND=1, the M2 readiness double-end regression) can run.
import https from 'node:https';
import fs from 'node:fs';

const PORT = process.env.PORT;
const ca = fs.readFileSync(process.env.TLS_CERT);
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

// The reused TLS socket, captured from the request's 'socket' event (res.socket is nulled once the
// response is released back to the agent), so request 2/3 reusing it proves a single TLS session.
let theSocket = null;

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', agent, ca },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, socket: theSocket }));
      },
    );
    r.on('socket', (s) => {
      theSocket = s;
    });
    r.on('error', reject);
    r.end('k' + path);
  });
}

try {
  const r1 = await req('/k1');
  const r2 = await req('/k2');
  const r3 = await req('/k3');
  const reused = r1.socket === r2.socket && r2.socket === r3.socket;
  let ok = true;
  for (const [r, p] of [
    [r1, '/k1'],
    [r2, '/k2'],
    [r3, '/k3'],
  ]) {
    const want = 'echo:POST:' + p + ':k' + p;
    if (r.status !== 200 || r.body !== want) {
      ok = false;
      console.error(
        'bad response for ' + p + ': status=' + r.status + ' body=' + JSON.stringify(r.body),
      );
    }
  }
  agent.destroy();
  if (ok && reused) {
    console.log('KEEPALIVE OK (3 requests, 1 TLS session, socket reused)');
    process.exit(0);
  } else {
    console.error('KEEPALIVE FAIL: reused=' + reused);
    process.exit(1);
  }
} catch (e) {
  console.error('KEEPALIVE FAIL: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
