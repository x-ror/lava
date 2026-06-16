// node:dns Tier 1 — dns.lookup (getaddrinfo) callback + promises forms. Kept
// network-free and deterministic so Node and Lava agree: only IP literals,
// localhost (hosts file), and the RFC 6761 reserved `.invalid` TLD (guaranteed
// NXDOMAIN everywhere). Asserts invariants only — no address text is printed,
// since the exact bytes/order can differ between resolvers. errno is not checked
// (Node uses a negative number; Lava carries the string code).
const assert = require('node:assert/strict');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');

function lookup(hostname, options) {
  return new Promise((resolve, reject) => {
    const cb = (err, address, family) => (err ? reject(err) : resolve({ address, family }));
    if (options === undefined) dns.lookup(hostname, cb);
    else dns.lookup(hostname, options, cb);
  });
}

function lookupAll(hostname, options) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, options, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });
}

async function main() {
  // module surface
  assert.equal(typeof dns.lookup, 'function');
  assert.equal(typeof dns.promises, 'object');
  assert.equal(typeof dns.promises.lookup, 'function');
  assert.equal(typeof dnsPromises.lookup, 'function');
  assert.equal(dns.NOTFOUND, 'ENOTFOUND');

  // IPv4 literal passes straight through getaddrinfo.
  const v4 = await lookup('127.0.0.1');
  assert.equal(v4.address, '127.0.0.1');
  assert.equal(v4.family, 4);

  // IPv6 literal.
  const v6 = await lookup('::1');
  assert.equal(v6.family, 6);
  assert.ok(v6.address.includes(':'));

  // localhost via hosts file, pinned to IPv4.
  const local = await lookup('localhost', { family: 4 });
  assert.equal(local.family, 4);
  assert.match(local.address, /^127\./);

  // all:true yields an array of { address, family } records.
  const all = await lookupAll('localhost', { all: true });
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 1);
  for (const rec of all) {
    assert.equal(typeof rec.address, 'string');
    assert.ok(rec.family === 4 || rec.family === 6);
  }

  // promises form resolves to { address, family }.
  const p = await dnsPromises.lookup('127.0.0.1');
  assert.equal(p.address, '127.0.0.1');
  assert.equal(p.family, 4);

  // Failed resolution rejects with a getaddrinfo ENOTFOUND error.
  await assert.rejects(lookup('lava-nonexistent.invalid'), (err) => {
    assert.equal(err.code, 'ENOTFOUND');
    assert.equal(err.syscall, 'getaddrinfo');
    assert.equal(err.hostname, 'lava-nonexistent.invalid');
    return true;
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
