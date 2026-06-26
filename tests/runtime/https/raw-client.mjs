// Raw-TCP adversarial client (Node) for the smoke. mode=timeout opens a connection and sends
// NOTHING — the server must reap it via the handshake-timeout reaper (the TLS-layer slowloris
// guard, exercised with a short LAVA_TLS_HANDSHAKE_TIMEOUT_MS). mode=garbage sends plaintext HTTP
// to the TLS port — SSL_accept sees a malformed ClientHello, fails the handshake, and the server
// closes the connection (no hang, no crash). Both assert the server closes us within a few seconds.
import net from 'node:net';

const PORT = process.env.PORT;
const mode = process.argv[2];
const t0 = Date.now();
let closed = false;

const sock = net.connect(PORT, '127.0.0.1');
sock.on('connect', () => {
  if (mode === 'garbage') sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  // mode === 'timeout': send nothing, stall the handshake.
});
sock.on('data', () => {}); // a TLS alert may arrive before close; ignore
sock.on('error', () => {}); // a peer RST surfaces as ECONNRESET — that's a close, not a failure
sock.on('close', () => {
  closed = true;
  console.log(
    mode.toUpperCase() + ' OK: server closed the connection after ' + (Date.now() - t0) + 'ms',
  );
  process.exit(0);
});

setTimeout(() => {
  if (!closed) {
    console.error(mode.toUpperCase() + ' FAIL: server did not close the connection (hang)');
    process.exit(1);
  }
}, 6000);
