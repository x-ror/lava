// net.connect parity: echo round-trip over a client socket + ECONNREFUSED.
const net = require('net');

function echoTest() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      sock.on('data', (d) => sock.write(d));
      sock.on('end', () => sock.end());
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const client = net.connect(port, '127.0.0.1', () => {
        console.log('connected');
        client.write('hello over connect');
      });
      let got = '';
      client.on('data', (d) => {
        got += d.toString();
        if (got === 'hello over connect') {
          console.log('echo:', got);
          client.end();
        }
      });
      client.on('close', () => {
        console.log('client closed');
        server.close(() => resolve());
      });
      client.on('error', reject);
    });
  });
}

function refusedTest() {
  return new Promise((resolve) => {
    // A port from the ephemeral range with nothing bound: connect must fail
    // asynchronously with ECONNREFUSED.
    const c = net.connect(1, '127.0.0.1');
    c.on('error', (e) => {
      console.log('refused code:', e.code);
      resolve();
    });
    c.on('connect', () => {
      console.log('UNEXPECTED connect');
      resolve();
    });
  });
}

async function main() {
  await echoTest();
  await refusedTest();
  console.log('ok');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
