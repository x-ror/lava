// Fetch transport smoke cases. Run under both Node and Lava against the sibling
// server.js; the two outputs must match exactly (see scripts/run-fetch-smoke.sh).
// FETCH_BASE points at the running origin, e.g. http://127.0.0.1:8799
const assert = require('node:assert/strict');

const base = process.env.FETCH_BASE;

async function main() {
  assert.equal(typeof fetch, 'function');

  // GET, Content-Length framing, text()
  const r1 = await fetch(base + '/hello.txt');
  assert.equal(r1.status, 200);
  assert.equal(r1.ok, true);
  console.log('hello.txt:', JSON.stringify(await r1.text()));

  // GET, json() + a response header
  const r2 = await fetch(base + '/data.json');
  console.log('data.json:', JSON.stringify(await r2.json()));
  console.log('content-type:', r2.headers.get('content-type'));

  // 404 still resolves with ok=false
  const r3 = await fetch(base + '/nope-not-here');
  console.log('missing ok/status:', r3.ok, r3.status);

  // Multi-byte UTF-8 response must decode correctly (not latin1 mojibake)
  const ru = await fetch(base + '/utf8');
  console.log('utf8:', JSON.stringify(await ru.text()));

  // POST with a JSON body, chunked response
  const r4 = await fetch(base + '/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 1, y: 'two' }),
  });
  const echoed = await r4.json();
  console.log('POST:', echoed.method, echoed.echo, echoed.len);

  // UTF-8 request body round-trips byte-exact through the transport
  const rb = await fetch(base + '/echo', { method: 'POST', body: 'héllo café ☕' });
  const back = await rb.json();
  console.log('POST utf8 echo:', JSON.stringify(back.echo));

  // invalid JSON rejects (json() must not throw synchronously)
  let jsonRejected = false;
  const rt = await fetch(base + '/hello.txt');
  await rt.json().catch(() => {
    jsonRejected = true;
  });
  console.log('bad json rejected:', jsonRejected);

  // A timer co-pending with an in-flight fetch must neither hang the request
  // (regression: io_uring re-arm submission) nor be dropped (regression: loop
  // clock advance + 1ms timer floor so a 0ms interval cannot starve the poll).
  const iv = setInterval(() => {}, 0);
  const timed = [];
  setTimeout(() => timed.push('timeout'), 5);
  const tr = await fetch(base + '/a').then((r) => r.text());
  clearInterval(iv);
  await new Promise((resolve) => setTimeout(resolve, 25));
  console.log('timer+fetch:', tr === 'AAA', timed.includes('timeout'));

  // Three concurrent requests resolve in Promise.all order
  const [a, b, c] = await Promise.all([
    fetch(base + '/a').then((r) => r.text()),
    fetch(base + '/b').then((r) => r.text()),
    fetch(base + '/c').then((r) => r.text()),
  ]);
  console.log('concurrent:', a, b, c);

  // IPv6 literal host: parse [::1], connect over AF_INET6, and re-bracket the
  // Host header. Only runs when the runner confirmed IPv6 loopback is up (it
  // sets FETCH_BASE6), so Node and Lava take this branch identically.
  const base6 = process.env.FETCH_BASE6;
  if (base6) {
    const r6 = await fetch(base6 + '/hello.txt');
    console.log('ipv6 hello:', r6.status, JSON.stringify(await r6.text()));
    const host6 = await fetch(base6 + '/host').then((r) => r.json());
    // Host must be the re-bracketed literal with the explicit port.
    console.log('ipv6 host header:', host6.host === base6.slice('http://'.length));
  }

  // Connection refused rejects (port 9 is the discard port, closed here)
  let refused = false;
  try {
    await fetch('http://127.0.0.1:9/x');
  } catch (error) {
    refused = true;
  }
  console.log('refused rejected:', refused);

  // A name that cannot resolve rejects (DNS now runs off the event loop, #30).
  // .invalid is reserved (RFC 6761) and never resolves.
  let dnsFailed = false;
  try {
    await fetch('http://does-not-exist.invalid/');
  } catch (error) {
    dnsFailed = true;
  }
  console.log('dns failure rejected:', dnsFailed);

  console.log('FETCH SMOKE OK');
}

main().catch((error) => {
  console.error('FETCH SMOKE FAIL:', error && error.message ? error.message : error);
  process.exit(1);
});
