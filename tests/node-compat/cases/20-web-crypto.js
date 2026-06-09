// WHATWG Web Crypto global (issue #62): crypto.randomUUID + crypto.getRandomValues.
// Pre-fix `globalThis.crypto` was undefined. Assertions are shape/relationship
// only (no random values printed), so Node and Lava produce identical output.
const assert = require('node:assert/strict');

assert.equal(typeof crypto, 'object');
assert.equal(typeof crypto.randomUUID, 'function');
assert.equal(typeof crypto.getRandomValues, 'function');

// randomUUID: RFC 4122 v4 shape + uniqueness.
assert.match(
  crypto.randomUUID(),
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
assert.notEqual(crypto.randomUUID(), crypto.randomUUID());

// getRandomValues fills in place and returns the same array.
const a = new Uint8Array(16);
assert.equal(crypto.getRandomValues(a), a);
assert.ok(a.some((x) => x !== 0)); // not all zero (2^-128 chance)

// Works on a non-Uint8 integer view at a byte offset, leaving other bytes alone.
const buf = new ArrayBuffer(32);
const view = new Uint32Array(buf, 8, 4);
crypto.getRandomValues(view);
assert.ok(Array.from(view).some((x) => x !== 0));
assert.ok(new Uint8Array(buf, 0, 8).every((x) => x === 0)); // bytes before the view
assert.ok(new Uint8Array(buf, 24, 8).every((x) => x === 0)); // bytes after the view

// node:crypto exposes getRandomValues too.
assert.equal(typeof require('node:crypto').getRandomValues, 'function');
