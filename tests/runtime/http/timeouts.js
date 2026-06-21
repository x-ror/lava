// http timeout / slowloris checks — run under Node against the Lava HTTP server started
// with HTTP_SHORT_TIMEOUTS=1 (keepAlive 250ms, headers 250ms, request 400ms). Verifies
// that slow/idle clients are evicted while a fast client is unaffected. Outcome-based
// (not tight timing) for CI stability. Connects to HTTP_PORT on 127.0.0.1.
const net = require('net');

const PORT = Number(process.env.HTTP_PORT);

function statusOf(r) {
  const m = (r || '').match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : 0;
}

// Connect, optionally write `initial`, never send more, and resolve once the server
// closes us (or after a safety deadline). `closedByDeadline` distinguishes a hang.
function probe(initial) {
  return new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1', () => {
      if (initial) c.write(Buffer.from(initial, 'latin1'));
    });
    let buf = '';
    let settled = false;
    const done = (closedByDeadline) => {
      if (settled) return;
      settled = true;
      resolve({ status: statusOf(buf), closedByDeadline });
    };
    c.on('data', (d) => (buf += d.toString('latin1')));
    c.on('close', () => done(false));
    c.on('error', () => done(false));
    setTimeout(() => {
      c.destroy();
      done(true);
    }, 2500); // > all the server's short timeouts; tripping this means it hung
  });
}

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
  // Idle: send nothing — the server must close us (keepAliveTimeout), with no response.
  let r = await probe(null);
  check('idle-evicted', !r.closedByDeadline && r.status === 0, JSON.stringify(r));

  // Slow head: a partial head that never completes — headersTimeout → 408.
  r = await probe('GET / HTTP/1.1\r\nHost: x\r\n');
  check('slow-head-408', r.status === 408, JSON.stringify(r));

  // Slow body: a complete head but only part of the declared body — requestTimeout → 408.
  r = await probe('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nABC');
  check('slow-body-408', r.status === 408, JSON.stringify(r));

  // Fast: a complete request is answered normally, not timed out.
  r = await probe('GET /fast HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('fast-not-timed-out', r.status === 200, JSON.stringify(r));

  console.log(failures === 0 ? 'HTTP TIMEOUTS OK' : 'HTTP TIMEOUTS FAILURES ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
