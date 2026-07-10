// HTTP header-bridge checks — Lava server only (run-http-smoke.sh phase).
// Locks the perf/buffer HTTP work:
//   - parseRequest ASCII-lowercases header NAMES (JS buildHeaders skips toLowerCase)
//   - header VALUES stay latin1 (obs-text 0x80-0xFF as single chars)
//   - response head serialization writes high latin1 as single bytes on the wire
// Connects to HTTP_PORT on 127.0.0.1. Exit non-zero on failure.
const net = require('net');

const PORT = Number(process.env.HTTP_PORT);

function raw(bytes) {
  return new Promise((resolve) => {
    const c = net.connect(PORT, '127.0.0.1', () => {
      c.write(Buffer.from(bytes, 'latin1'));
    });
    let buf = Buffer.alloc(0);
    c.on('data', (d) => (buf = Buffer.concat([buf, d])));
    c.on('close', () => resolve(buf));
    c.on('error', () => resolve(buf));
    setTimeout(() => c.destroy(), 4000);
  });
}

const statusOf = (r) => {
  const s = typeof r === 'string' ? r : r.toString('latin1');
  const m = s.match(/^HTTP\/1\.1 (\d{3})/);
  return m ? Number(m[1]) : 0;
};
const bodyOf = (buf) => {
  const s = buf.toString('latin1');
  const i = s.indexOf('\r\n\r\n');
  return i < 0 ? '' : s.slice(i + 4);
};

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
  // 1. Mixed-case request header names fold to lowercase keys (native http_ascii_lower).
  //    Wire: Host + Content-Type + X-Foo; body must expose host / content-type / x-foo keys
  //    and values readable via lowercased lookup.
  let buf = await raw(
    'GET /headers-meta HTTP/1.1\r\n' +
      'Host: example.test\r\n' +
      'Content-Type: text/plain\r\n' +
      'X-Foo: Bar\r\n' +
      'Connection: close\r\n\r\n',
  );
  let body = bodyOf(buf);
  check('status-200-meta', statusOf(buf) === 200, buf.toString('latin1').slice(0, 40));
  check(
    'keys-lowercased',
    /KEYS=/.test(body) &&
      body.indexOf('host') !== -1 &&
      body.indexOf('content-type') !== -1 &&
      body.indexOf('x-foo') !== -1 &&
      !/\bHost\b/.test(body) &&
      !/\bContent-Type\b/.test(body) &&
      !/\bX-Foo\b/.test(body),
    body.slice(0, 120),
  );
  check('host-value', /HOST=101,120,97,109,112,108,101,46,116,101,115,116\b/.test(body), body); // example.test
  check('x-foo-value', /XFOO=66,97,114\b/.test(body), body); // Bar

  // 2. Duplicate headers with different wire casing merge under one lowercased key
  //    (Node: "a, b" join for most headers).
  buf = await raw(
    'GET /headers-meta HTTP/1.1\r\n' +
      'Host: x\r\n' +
      'X-A: one\r\n' +
      'x-a: two\r\n' +
      'X-a: three\r\n' +
      'Connection: close\r\n\r\n',
  );
  body = bodyOf(buf);
  // "one, two, three" → char codes
  const expected =
    'XA=' +
    Array.from('one, two, three')
      .map((c) => c.charCodeAt(0))
      .join(',');
  check('duplicate-case-merge', body.indexOf(expected) !== -1, body.slice(0, 160));
  // Only one x-a key in KEYS=
  const keysMatch = body.match(/KEYS=([^ ]*)/);
  const keys = keysMatch ? keysMatch[1].split('|') : [];
  check(
    'duplicate-single-key',
    keys.filter((k) => k === 'x-a').length === 1,
    'keys=' + keys.join('|'),
  );

  // 3. High-byte header value (0xE9) round-trips as U+00E9, not mangled multi-byte.
  buf = await raw(
    'GET /headers-meta HTTP/1.1\r\nHost: x\r\nX-Foo: \xe9\x80\xff\r\nConnection: close\r\n\r\n',
  );
  body = bodyOf(buf);
  check('latin1-value-codes', /XFOO=233,128,255\b/.test(body), body.slice(0, 120));

  // 4. Response head on a real server: X-High value is three raw latin1 bytes on the wire.
  buf = await raw('GET /resp-high HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  check('resp-high-status', statusOf(buf) === 200, buf.toString('latin1').slice(0, 40));
  const needle = Buffer.from('X-High: ', 'latin1');
  const idx = buf.indexOf(needle);
  check('resp-high-header-present', idx >= 0, buf.toString('latin1').slice(0, 80));
  if (idx >= 0) {
    check('resp-high-e9-byte', buf[idx + needle.length] === 0xe9);
    check('resp-high-80-byte', buf[idx + needle.length + 1] === 0x80);
    check('resp-high-ff-byte', buf[idx + needle.length + 2] === 0xff);
  }
  check(
    'resp-high-no-utf8-e9',
    !buf.includes(Buffer.from([0xc3, 0xa9])),
    'unexpected UTF-8 é in response',
  );
  check('resp-high-body', bodyOf(buf) === 'ok' || bodyOf(buf).endsWith('ok'), bodyOf(buf));

  // 5. Method / URL still parse with mixed-case headers present.
  buf = await raw(
    'POST /headers-meta HTTP/1.1\r\nHOST: z\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  );
  body = bodyOf(buf);
  check('method-post', /METHOD=POST\b/.test(body), body);
  check('url-meta', /URL=\/headers-meta\b/.test(body), body);

  console.log(failures === 0 ? 'HTTP HEADERS-BRIDGE OK' : 'HTTP HEADERS-BRIDGE FAILURES ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})();
