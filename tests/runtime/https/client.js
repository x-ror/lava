// HTTPS smoke client — driven by Lava's OWN TLS client (fetch) against the Lava HTTPS server,
// so the suite is a closed loop (lava-server ↔ lava-client). SSL_CERT_FILE (set by the runner)
// makes fetch trust the self-signed CA. Asserts: status, the X-Secure (req.socket.encrypted)
// header, byte-exact echo bodies over sequential AND concurrent requests, and a 2 MiB body.
const PORT = process.env.PORT;
const base = 'https://127.0.0.1:' + PORT;
const BIG = 2 * 1024 * 1024;

async function echoReq(i) {
  const r = await fetch(base + '/e' + i, { method: 'POST', body: 'p' + i });
  if (r.status !== 200) throw new Error('status ' + r.status + ' for /e' + i);
  if (r.headers.get('x-secure') !== 'true') throw new Error('X-Secure not true for /e' + i);
  const t = await r.text();
  const want = 'echo:POST:/e' + i + ':p' + i;
  if (t !== want) throw new Error('body mismatch for /e' + i + ': got ' + JSON.stringify(t));
}

async function bigReq() {
  const r = await fetch(base + '/big');
  if (r.status !== 200) throw new Error('big status ' + r.status);
  const u = new Uint8Array(await r.arrayBuffer());
  if (u.length !== BIG) throw new Error('big length ' + u.length + ' != ' + BIG);
  for (let i = 0; i < BIG; i++) {
    if (u[i] !== ((i * 31 + 7) & 0xff)) throw new Error('big mismatch at byte ' + i);
  }
}

(async () => {
  for (let i = 0; i < 20; i++) await echoReq(i); // sequential: repeated handshakes + teardown
  await Promise.all(Array.from({ length: 20 }, (_, i) => echoReq(100 + i))); // concurrent
  await bigReq(); // large body
  console.log('HTTPS SMOKE OK');
})().catch((e) => {
  console.error('HTTPS SMOKE FAIL: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
