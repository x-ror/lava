// node:dns Tier 1 — dns.lookup (the core:net resolver) callback + promises forms.
// Kept network-free and deterministic so Node and Lava agree: only IP literals,
// localhost (hosts file), and the RFC 6761 reserved `.invalid` TLD (guaranteed
// NXDOMAIN everywhere). Address text/order are not printed (resolvers differ);
// the case asserts shapes, families, option validation, and the result-order API.
//
// This case stays exit-0. The abnormal-teardown safety fix (a dns.lookup left in
// flight when a top-level throw skips the event loop must not post into a freed
// loop) cannot be a compared case — node and lava print different uncaught-error
// text — so it is exercised by tests/node-compat/fixtures/dns-teardown.js and the
// PR verifies that fixture exits non-zero without crashing on both runtimes.
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
  // ---- module surface ----
  assert.equal(typeof dns.lookup, 'function');
  assert.equal(typeof dns.promises, 'object');
  assert.equal(typeof dns.promises.lookup, 'function');
  assert.equal(typeof dnsPromises.lookup, 'function');
  assert.equal(dns.NOTFOUND, 'ENOTFOUND');

  // getaddrinfo hint flags match Node's numeric values (callers do bitwise math).
  assert.equal(dns.ADDRCONFIG, 32);
  assert.equal(dns.V4MAPPED, 8);
  assert.equal(dns.ALL, 16);

  // ---- result-order API ----
  assert.equal(typeof dns.setDefaultResultOrder, 'function');
  assert.equal(dns.getDefaultResultOrder(), 'verbatim'); // Node's default since v17
  for (const order of ['ipv4first', 'ipv6first', 'verbatim']) {
    dns.setDefaultResultOrder(order);
    assert.equal(dns.getDefaultResultOrder(), order);
  }
  assert.throws(
    () => dns.setDefaultResultOrder('sideways'),
    (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_VALUE',
  );
  dns.setDefaultResultOrder('verbatim'); // restore

  // ---- option validation: Node rejects bad types/values synchronously ----
  const TYPE = (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE';
  const VALUE = (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_VALUE';
  const noop = () => {};

  assert.throws(() => dns.lookup('localhost', { family: 5 }, noop), VALUE);
  assert.throws(() => dns.lookup('localhost', { family: '4' }, noop), VALUE); // string '4' is not 4
  assert.throws(() => dns.lookup('localhost', 5, noop), VALUE); // numeric family shorthand
  assert.throws(() => dns.lookup('localhost', { all: 'yes' }, noop), TYPE);
  assert.throws(() => dns.lookup('localhost', true, noop), TYPE); // options must be object/integer
  assert.throws(() => dns.lookup('localhost', { hints: 1 }, noop), VALUE); // unknown hint bit
  assert.throws(() => dns.lookup('localhost', { hints: 'x' }, noop), TYPE);
  assert.throws(() => dns.lookup('localhost', { order: 'bad' }, noop), VALUE);
  assert.throws(() => dns.lookup('localhost', { verbatim: 1 }, noop), TYPE);
  assert.throws(() => dns.lookup('localhost', {}), TYPE); // missing callback
  assert.throws(() => dns.lookup(123, noop), TYPE); // non-string truthy hostname

  // Valid options must NOT throw: the 'IPv4'/'IPv6' aliases, known hints, order.
  assert.doesNotThrow(() => dns.lookup('localhost', { family: 'IPv4' }, noop));
  assert.doesNotThrow(() => dns.lookup('localhost', { family: 'IPv6' }, noop));
  assert.doesNotThrow(() =>
    dns.lookup('localhost', { hints: dns.ADDRCONFIG | dns.V4MAPPED }, noop),
  );
  assert.doesNotThrow(() => dns.lookup('localhost', { order: 'ipv6first' }, noop));
  assert.doesNotThrow(() => dns.lookup('localhost', { verbatim: false }, noop));

  // ---- IP literals pass straight through, keeping their own family ----
  const v4 = await lookup('127.0.0.1');
  assert.equal(v4.address, '127.0.0.1');
  assert.equal(v4.family, 4);

  const v6 = await lookup('::1');
  assert.equal(v6.family, 6);
  assert.ok(v6.address.includes(':'));

  // A literal ignores a mismatched family filter (getaddrinfo AI_NUMERICHOST).
  const v4as6 = await lookup('127.0.0.1', { family: 6 });
  assert.equal(v4as6.address, '127.0.0.1');
  assert.equal(v4as6.family, 4);
  const v6as4 = await lookup('::1', { family: 4 });
  assert.equal(v6as4.family, 6);

  // all:true over a literal yields a one-element record list (family preserved).
  const litAll = await lookupAll('127.0.0.1', { family: 6, all: true });
  assert.deepEqual(litAll, [{ address: '127.0.0.1', family: 4 }]);

  // ---- localhost via the hosts file, pinned to IPv4 ----
  const local = await lookup('localhost', { family: 4 });
  assert.equal(local.family, 4);
  assert.match(local.address, /^127\./);

  // all:true yields the full record list (not a single capped pair).
  const all = await lookupAll('localhost', { all: true });
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 1);
  for (const rec of all) {
    assert.equal(typeof rec.address, 'string');
    assert.ok(rec.family === 4 || rec.family === 6);
  }
  // An ipv4first all-lookup keeps every IPv4 record ahead of any IPv6 record.
  const ordered = await lookupAll('localhost', { all: true, order: 'ipv4first' });
  let seenV6 = false;
  for (const rec of ordered) {
    if (rec.family === 6) seenV6 = true;
    else assert.ok(!seenV6, 'IPv4 record must not follow an IPv6 record under ipv4first');
  }

  // ---- promises form resolves to { address, family } ----
  const p = await dnsPromises.lookup('127.0.0.1');
  assert.equal(p.address, '127.0.0.1');
  assert.equal(p.family, 4);
  const pAll = await dnsPromises.lookup('127.0.0.1', { all: true });
  assert.deepEqual(pAll, [{ address: '127.0.0.1', family: 4 }]);

  // ---- failed resolution rejects with a getaddrinfo ENOTFOUND error ----
  await assert.rejects(lookup('lava-nonexistent.invalid'), (err) => {
    assert.equal(err.code, 'ENOTFOUND');
    assert.equal(err.syscall, 'getaddrinfo');
    assert.equal(err.hostname, 'lava-nonexistent.invalid');
    return true;
  });
}

main()
  .then(() => console.log('dns ok'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
