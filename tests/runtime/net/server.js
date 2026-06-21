// net smoke fixture: a TCP echo server. Run under BOTH Node and Lava by
// scripts/run-net-smoke.sh; the same Node client (client.js) hits each and the
// outputs must match. Binds an ephemeral port and prints it as READYPORT=<port>
// so the harness can find it. Echoes every chunk and ends when the peer ends.
const net = require('node:net');

const server = net.createServer((socket) => {
  socket.on('data', (chunk) => socket.write(chunk));
  socket.on('end', () => socket.end());
  socket.on('error', () => {}); // ignore peer resets — the client drives teardown
});

server.on('error', (e) => {
  console.error('server error', e && e.message);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  console.log('READYPORT=' + server.address().port);
});
