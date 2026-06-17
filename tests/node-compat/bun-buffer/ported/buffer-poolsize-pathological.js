// Pathological Buffer.poolSize values (issue #213). Realistic code never touches
// Buffer.poolSize (the default is 8192 on Node <= 25 / Bun, 65536 on Node >= 26.3,
// which Lava follows), but Node has well-defined behavior for
// fractional, negative, zero, NaN, and >= 2^32 values, and Lava now matches it:
//   * poolSize is a plain data property — it stores and returns the raw value, with
//     no >>> coercion on read.
//   * createPool() sizes the pool straight from Buffer.poolSize (like Node's
//     `new Uint8Array(Buffer.poolSize)`), so a fractional value is truncated and an
//     invalid one is rejected by the typed-array length check — rather than the old
//     `>>> 0`, which wrapped a negative value to a ~4 GiB request.
//   * the pooling threshold keeps Node's `Buffer.poolSize >>> 1` quirk verbatim.
//
// All assertions are pure ArrayBuffer/Uint8Array semantics, identical on Linux,
// macOS/Darwin, and Windows, and none of them allocates anything large.
const assert = require('node:assert/strict');
const DEFAULT = Buffer.poolSize; // runtime default (8192 on Node <= 25 / Bun, 65536 on Node >= 26.3)

assert.ok(
  Buffer.poolSize > 0 && (Buffer.poolSize & (Buffer.poolSize - 1)) === 0,
  'default poolSize is a positive power of two',
);

// --- poolSize getter returns the raw assigned value (no coercion) -----------
for (const v of [8192, 8192.7, 0, 1, -1, -8192, NaN, 2 ** 31, 2 ** 32, 2 ** 32 + 100, 1e12]) {
  Buffer.poolSize = v;
  assert.ok(Object.is(Buffer.poolSize, v), 'poolSize reads back raw: ' + v);
}
Buffer.poolSize = DEFAULT;

// --- Pooling decision per poolSize, without forcing a re-pool ----------------
// A single small allocUnsafe is served from the still-warm pool when
// `size < (poolSize >>> 1)` and otherwise gets its own store; nothing here drains
// the pool, so no re-pool (hence no large/throwing allocation) occurs. 'pool' means
// the result is backed by the shared pool, 'own' means a right-sized private store.
function decision(v) {
  Buffer.poolSize = v;
  const b = Buffer.allocUnsafe(10);
  return b.buffer.byteLength === b.length ? 'own' : 'pool';
}
const matrix = {};
for (const v of [8192, 8192.7, 0, 1, 2, 4097, 2 ** 32, 2 ** 32 + 100, NaN, Infinity]) {
  matrix[String(v)] = decision(v);
}
Buffer.poolSize = DEFAULT;
console.log(JSON.stringify(matrix));

// Pin the decisions so the case self-checks on the Node oracle too. These follow
// Node's `>>> 1` threshold: 0/1/2 -> 0, so the 10-byte request is never pooled;
// 2^32 >>> 1 === 0 (wraps) -> own; 2^32+100 >>> 1 === 50 -> pooled; NaN/Infinity
// >>> 1 === 0 -> own; fractional 8192.7 truncates like 8192 -> pooled.
assert.deepEqual(matrix, {
  8192: 'pool',
  8192.7: 'pool',
  0: 'own',
  1: 'own',
  2: 'own',
  4097: 'pool',
  4294967296: 'own',
  4294967396: 'pool',
  NaN: 'own',
  Infinity: 'own',
});

// --- A re-pool under an invalid poolSize throws a clean RangeError -----------
// Draining the pool forces createPool() to run under the bad value. Node sizes its
// pool with `new Uint8Array(poolSize)` and Lava does the equivalent, so both reject
// poolSize = -1 with a catchable RangeError — no multi-GiB allocation, no crash.
// This is the LAST action: a failed re-pool leaves Node's internal pool state
// inconsistent, so we must not allocate again afterward.
//
// Shrink to a small pool and allocate until the backing store is recreated at
// least once — that lands us on a known small pool regardless of the runtime's
// default size (8192 vs 65536), so the subsequent drain is guaranteed to exhaust
// it and trigger createPool(-1).
Buffer.poolSize = 1024;
let warm = Buffer.allocUnsafe(16).buffer;
for (let i = 0; i < 200000; i++) {
  const next = Buffer.allocUnsafe(16).buffer;
  if (next !== warm) break; // re-pooled onto a fresh 1024-byte pool
  warm = next;
}
Buffer.poolSize = -1;
let threw = false;
try {
  for (let i = 0; i < 4000; i++) Buffer.allocUnsafe(8); // exhausts the small pool -> createPool(-1)
} catch (e) {
  threw = e instanceof RangeError;
}
Buffer.poolSize = DEFAULT;
assert.ok(threw, 're-pool under a negative poolSize throws a catchable RangeError');

console.log('buffer-poolsize-pathological OK');
