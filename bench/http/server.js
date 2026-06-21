// HTTP server benchmark fixture — a hello-world keep-alive server. Run under Node, Lava,
// and Bun by bench/http/run-http-bench.mjs. Plain node:http so all three accept it.
const http = require('node:http');

const BODY = Buffer.from('Hello, World!');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(BODY);
});

// Disable idle keep-alive eviction so the memory-per-connection probe can hold idle
// connections open (Node/Bun default to a few seconds; Lava's M5 to 5s). Harmless where
// the property isn't honored.
server.keepAliveTimeout = 0;

server.listen(0, '127.0.0.1', function () {
  console.log('READYPORT=' + this.address().port);
});
