// T5 client (Node): keep-alive, two requests on ONE TLS session. Request /first triggers a
// server.close() while this connection is live; request /second then runs over the SAME (now
// SSL_CTX-freed-at-listener-level) session and must still succeed — proving the per-conn SSL still
// works after the listener context was freed. Then the agent closes so the server can finish closing.
import https from 'node:https';
import fs from 'node:fs';

const PORT = process.env.PORT;
const ca = fs.readFileSync(process.env.TLS_CERT);
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', agent, ca },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, socket: res.socket }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

try {
  const r1 = await req('/first');
  await new Promise((r) => setTimeout(r, 150)); // let server.close() run while we hold the socket
  const r2 = await req('/second');
  const reused = r1.socket === r2.socket;
  agent.destroy();
  if (r1.status === 200 && r2.status === 200 && r2.body === 'echo:GET:/second:' && reused) {
    console.log('CLOSE-LIVE OK (request after server.close on a live TLS session, ctx-free safe)');
  } else {
    console.error(
      'CLOSE-LIVE FAIL: r1=' +
        r1.status +
        ' r2=' +
        r2.status +
        ' reused=' +
        reused +
        ' body=' +
        r2.body,
    );
    process.exit(1);
  }
} catch (e) {
  console.error('CLOSE-LIVE FAIL: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
