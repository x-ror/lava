// net smoke client — always run under Node, against the echo server (server.js)
// running under either Node or Lava. Its stdout is deterministic regardless of
// which runtime serves, so the harness compares the two server runtimes for parity.
// Connects to NET_PORT on 127.0.0.1.
const net = require('node:net');

const PORT = Number(process.env.NET_PORT);

// One request: connect, send `payload`, end the write side, collect the echo until
// the server closes, resolve with the concatenated bytes.
function once(payload) {
  return new Promise((resolve, reject) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.end(payload));
    const chunks = [];
    c.on('data', (d) => chunks.push(d));
    c.on('close', () => resolve(Buffer.concat(chunks)));
    c.on('error', reject);
  });
}

(async () => {
  // Small echo.
  const small = await once(Buffer.from('hello-net'));
  console.log('echo-small', JSON.stringify(small.toString()));

  // Large echo — crosses socket buffers, exercising the server's partial-write /
  // backpressure path. Report length + byte-equality, not the bytes.
  const big = Buffer.alloc(256 * 1024, 0x61);
  const echoed = await once(big);
  console.log('echo-big', echoed.length, echoed.equals(big));

  // A few sequential connections — accept/close churn.
  let seqOk = 0;
  for (let i = 0; i < 5; i++) {
    const r = await once(Buffer.from('seq-' + i));
    if (r.toString() === 'seq-' + i) seqOk++;
  }
  console.log('echo-seq', seqOk);

  // Reentrant destroy: the server destroy()s from inside its 'data' handler, so the connection
  // closes with no echo. Exercises teardown-from-callback identically on both server backends.
  const destroyedLen = await new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1', () => c.write('DESTROY-now'));
    const chunks = [];
    c.on('data', (d) => chunks.push(d));
    c.on('close', () => resolve(Buffer.concat(chunks).length));
    c.on('error', () => {}); // a server destroy() may surface as ECONNRESET; 'close' still fires
  });
  console.log('destroy-noecho', destroyedLen === 0);

  console.log('NET SMOKE OK');
})().catch((e) => {
  console.error('client error', e && e.message);
  process.exit(1);
});
