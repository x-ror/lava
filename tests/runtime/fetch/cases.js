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

  // --- Streaming response/request bodies (issue #31) ---
  // The large bodies below cross the response-body backpressure high-water mark,
  // so they exercise the pause/resume path. Chunk boundaries are transport
  // defined, so the assertions only compare reassembled content, never chunk
  // counts or sizes (which legitimately differ between Node and Lava).
  const BIG = 'x'.repeat(200000);
  const BIG_CL = 'y'.repeat(200000);

  // response.body.getReader(): incremental reads reassemble to the full body.
  {
    const r = await fetch(base + '/big');
    assert.equal(r.body.locked, false);
    const reader = r.body.getReader();
    assert.equal(r.body.locked, true);
    const dec = new TextDecoder();
    let out = '';
    let first = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first === null) first = value instanceof Uint8Array;
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    console.log('stream getReader:', first, out === BIG, r.bodyUsed);
  }

  // Content-Length-framed large body streams the same way.
  {
    let total = 0;
    for await (const chunk of (await fetch(base + '/big-cl')).body) total += chunk.length;
    console.log('stream asyncIterator:', total === BIG_CL.length);
  }

  // Buffered APIs still work over the streaming transport: text() drains the
  // stream, json()/arrayBuffer() too.
  {
    const t = await (await fetch(base + '/big')).text();
    console.log('buffered text after stream:', t.length === BIG.length, t === BIG);
    const ab = await (await fetch(base + '/data.json')).arrayBuffer();
    console.log('buffered arrayBuffer:', ab.byteLength, ab instanceof ArrayBuffer);
  }

  // Request body streaming: an async generator body (buffered before send in v1).
  // Node requires duplex:'half' for stream bodies; Lava matches.
  {
    async function* gen() {
      yield new TextEncoder().encode('strm-');
      yield new TextEncoder().encode('body');
    }
    const rq = await fetch(base + '/echo', { method: 'POST', body: gen(), duplex: 'half' });
    const j = await rq.json();
    console.log('request stream echo:', JSON.stringify(j.echo), j.len);

    // A Blob request body (no duplex required) round-trips byte-exact.
    const rb2 = await fetch(base + '/echo', { method: 'POST', body: new Blob(['blob ', 'data']) });
    console.log('request blob echo:', JSON.stringify((await rb2.json()).echo));
  }

  // A body can be consumed only once; a second attempt rejects with a TypeError.
  {
    const r = await fetch(base + '/a');
    const t1 = await r.text();
    let secondErr = '';
    try {
      await r.text();
    } catch (error) {
      secondErr = error && error.constructor.name;
    }
    console.log('double consume:', t1, secondErr);

    // Once a reader is acquired the body is locked; buffered reads then reject.
    const rl = await fetch(base + '/a');
    const rd = rl.body.getReader();
    let lockedErr = '';
    try {
      await rl.text();
    } catch (error) {
      lockedErr = error && error.constructor.name;
    }
    console.log('locked body:', rl.body.locked, lockedErr);
    await rd.cancel();
  }

  // Empty body: a 204 response exposes a null body (no stream).
  {
    const r = await fetch(base + '/empty');
    console.log('empty body:', r.body === null, r.status);
  }

  // Cancellation / early close: cancelling the reader mid-stream tears the
  // transport down; the body is then marked used and further reads report done.
  {
    const r = await fetch(base + '/big');
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    const after = await reader.read();
    console.log('cancel mid-stream:', r.bodyUsed, after.done);
  }

  // Error propagation during streaming: a truncated body (declared length not
  // met before the connection drops) rejects the body read with a TypeError,
  // after the response head has already resolved.
  {
    const r = await fetch(base + '/truncate');
    let streamErr = '';
    try {
      await r.text();
    } catch (error) {
      streamErr = error && error.constructor.name;
    }
    console.log('truncated stream:', r.status, streamErr);
  }

  // Malformed chunked framing (chunk data not followed by CRLF) must reject the
  // body read, not be accepted as valid bytes.
  {
    const r = await fetch(base + '/badchunk');
    let err = '';
    try {
      await r.text();
    } catch (error) {
      err = error && error.constructor.name;
    }
    console.log('malformed chunk:', r.status, err);
  }

  // Abort AFTER the response head has resolved must still tear the body down: the
  // in-flight body read rejects with the signal's AbortError. /slowbody sends one
  // chunk then stalls, so the abort — not EOF — ends the read.
  {
    const ac = new AbortController();
    const r = await fetch(base + '/slowbody', { signal: ac.signal });
    const reader = r.body.getReader();
    await reader.read(); // first chunk ('partial')
    ac.abort();
    let name = '';
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (error) {
      name = error && error.name;
    }
    console.log('abort after headers:', name);
  }

  // fetch(new Request(url, { body: <stream>, duplex: 'half' })) — the streaming
  // body must survive Request construction and reach the server (not be dropped).
  {
    async function* gen() {
      yield new TextEncoder().encode('req-');
      yield new TextEncoder().encode('obj-body');
    }
    const rq = new Request(base + '/echo', { method: 'POST', body: gen(), duplex: 'half' });
    const echoed = await fetch(rq).then((r) => r.json());
    console.log('request-object stream body:', JSON.stringify(echoed.echo));
  }

  // clone() tees a streaming body: both responses read the full content.
  {
    const r = await fetch(base + '/big');
    const r2 = r.clone();
    const [t1, t2] = await Promise.all([r.text(), r2.text()]);
    console.log('clone tee:', t1.length === BIG.length, t1 === t2);
  }

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

  // HTTPS over TLS: same assertions as the plaintext path, against a self-signed
  // origin the runner taught both runtimes to trust (NODE_EXTRA_CA_CERTS for
  // Node, SSL_CERT_FILE for Lava's OpenSSL). Only runs when the runner started
  // the TLS listener, so Node and Lava take this branch identically.
  const baseHttps = process.env.FETCH_BASE_HTTPS;
  if (baseHttps) {
    const s1 = await fetch(baseHttps + '/hello.txt');
    console.log('https hello:', s1.status, JSON.stringify(await s1.text()));
    const s2 = await fetch(baseHttps + '/data.json');
    console.log('https json:', JSON.stringify(await s2.json()));
    const s3 = await fetch(baseHttps + '/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tls: true, n: 7 }),
    });
    const se = await s3.json();
    console.log('https POST:', se.method, se.echo, se.len);
    // Concurrent HTTPS requests each get their own TLS session.
    const [sa, sb] = await Promise.all([
      fetch(baseHttps + '/a').then((r) => r.text()),
      fetch(baseHttps + '/b').then((r) => r.text()),
    ]);
    console.log('https concurrent:', sa, sb);
  }

  // Negative TLS: a server whose certificate is trusted (same CA bundle) but
  // whose SAN does not cover 127.0.0.1. The fetch must reject on the hostname
  // mismatch, proving certificate verification is actually enforced (not just
  // that trusted certs are accepted). Only runs when the runner started it.
  const baseHttpsBad = process.env.FETCH_BASE_HTTPS_BAD;
  if (baseHttpsBad) {
    let tlsRejected = false;
    try {
      await fetch(baseHttpsBad + '/hello.txt');
    } catch {
      tlsRejected = true;
    }
    console.log('https hostname-mismatch rejected:', tlsRejected);
  }

  // Connection refused rejects (port 9 is the discard port, closed here)
  let refused = false;
  try {
    await fetch('http://127.0.0.1:9/x');
  } catch {
    refused = true;
  }
  console.log('refused rejected:', refused);

  // A name that cannot resolve rejects (DNS now runs off the event loop, #30).
  // .invalid is reserved (RFC 6761) and never resolves.
  let dnsFailed = false;
  try {
    await fetch('http://does-not-exist.invalid/');
  } catch {
    dnsFailed = true;
  }
  console.log('dns failure rejected:', dnsFailed);

  // Pre-aborted signal rejects immediately with an AbortError, never connects.
  let preAbortName = '';
  try {
    await fetch(base + '/hello.txt', { signal: AbortSignal.abort() });
  } catch (error) {
    preAbortName = error && error.name;
  }
  console.log('pre-aborted name:', preAbortName);

  // AbortController.abort() mid-flight rejects with AbortError and exits promptly.
  let midFlightName = '';
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  try {
    await fetch(base + '/never', { signal: ac.signal });
  } catch (error) {
    midFlightName = error && error.name;
  }
  console.log('mid-flight abort name:', midFlightName);

  // AbortSignal.timeout() against a never-responding server rejects and exits.
  let timeoutName = '';
  try {
    await fetch(base + '/never', { signal: AbortSignal.timeout(50) });
  } catch (error) {
    timeoutName = error && error.name;
  }
  console.log('timeout abort name:', timeoutName);

  console.log('FETCH SMOKE OK');
}

main().catch((error) => {
  console.error('FETCH SMOKE FAIL:', error && error.message ? error.message : error);
  process.exit(1);
});
