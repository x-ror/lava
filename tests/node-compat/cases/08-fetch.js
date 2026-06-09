const assert = require('node:assert/strict');

async function main() {
  const response = new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' },
    status: 201,
  });

  assert.equal(typeof fetch, 'function');
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { ok: true });

  // Headers value normalization (Fetch spec "normalize a byte sequence"):
  // leading/trailing HTTP whitespace — tab, LF, CR, space — is stripped from
  // the value on the public set/append path, matching Node (undici).
  const h = new Headers();
  h.set('x-a', '  spaced value  ');
  assert.equal(h.get('x-a'), 'spaced value');

  // Object- and array-init constructors run through append, so they trim too.
  assert.equal(new Headers({ 'x-b': '\tleading-tab' }).get('x-b'), 'leading-tab');
  assert.equal(new Headers([['x-c', '  v  ']]).get('x-c'), 'v');

  // Leading/trailing CR and LF are HTTP whitespace: they are trimmed, not
  // rejected. Only an interior CR/LF (which survives the trim) is invalid.
  h.set('x-d', '\r\nfoo');
  assert.equal(h.get('x-d'), 'foo');
  h.set('x-e', 'foo\r\n');
  assert.equal(h.get('x-e'), 'foo');
  h.set('x-f', '\t \r\n trimme  d \r\n \t');
  assert.equal(h.get('x-f'), 'trimme  d');
  h.set('x-g', '\t \r\n ');
  assert.equal(h.get('x-g'), '');
  assert.throws(() => h.set('x-bad', 'foo\r\nbar'), TypeError);

  // Vertical tab (0x0B) and form feed (0x0C) are not HTTP whitespace — kept.
  h.set('x-h', 'vtab');
  assert.equal(h.get('x-h'), 'vtab');
  h.set('x-i', '\f formfeed');
  assert.equal(h.get('x-i'), '\f formfeed');

  // append normalizes each value, and duplicates join the trimmed values.
  const h2 = new Headers();
  h2.append('x-k', '  a  ');
  h2.append('x-k', '  b  ');
  assert.equal(h2.get('x-k'), 'a, b');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
