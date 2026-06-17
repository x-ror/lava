// Oversized typed-array / ArrayBuffer / Buffer allocations must throw a catchable
// error rather than aborting the process. Unlike V8 (Node), JavaScriptCore (Lava)
// aborts on an in-range-but-too-large allocation it cannot satisfy; Lava guards the
// global typed-array/ArrayBuffer constructors (js/internal/alloc_guard.js) and the
// Buffer layer so the request throws first. Every size here is rejected by the
// length/range check *before* any memory is reserved, so the test never tries to
// allocate gigabytes on either runtime — it is safe on Linux, macOS, and Windows.
//
// NOTE: the sizes below (> 2**53-1) are rejected by BOTH engines' own ToIndex check
// before any allocation, so this case proves "throws RangeError" and Node parity but
// does NOT prove the guard itself does anything. The guard's real job — rejecting a
// size the engine *would* allocate, without aborting — is covered lava-only by
// tests/runtime/alloc-guard/cap.js (run via `make test-alloc-guard-smoke`), which
// uses a tiny LAVA_MAX_BUFFER_BYTES so it can reject kilobyte-sized requests.
const assert = require('node:assert/strict');
const buffer = require('node:buffer');

// Sizes guaranteed to exceed both V8's and JSC's ceilings, so both runtimes reject
// them up front. 2**53 is one past Number.MAX_SAFE_INTEGER; 1e30 is absurdly large.
const HUGE = 2 ** 53;
const HUGER = 1e30;

// Buffer paths keep Node's coded RangeError; raw typed-array/ArrayBuffer paths throw
// a plain RangeError (matching V8's uncoded "Invalid typed array length").
const rangeErr = { code: 'ERR_OUT_OF_RANGE', name: 'RangeError' };

// --- Raw typed arrays: a too-large element count throws RangeError on both. ------
const typedArrays = [
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
];
for (const TA of typedArrays) {
  assert.throws(() => new TA(HUGE), RangeError);
  assert.throws(() => new TA(HUGER), RangeError);
}

// BigInt-backed views (8 bytes/element) — present on both runtimes.
assert.throws(() => new BigInt64Array(HUGE), RangeError);
assert.throws(() => new BigUint64Array(HUGE), RangeError);

// --- Raw ArrayBuffer (and SharedArrayBuffer when available). --------------------
assert.throws(() => new ArrayBuffer(HUGE), RangeError);
assert.throws(() => new ArrayBuffer(HUGER), RangeError);
if (typeof SharedArrayBuffer === 'function') {
  assert.throws(() => new SharedArrayBuffer(HUGE), RangeError);
}

// --- Buffer allocation paths: rejected before JSC is asked to allocate. ---------
const tooBig = buffer.constants.MAX_LENGTH + 1; // one past the advertised ceiling
assert.throws(() => Buffer.alloc(tooBig), rangeErr);
assert.throws(() => Buffer.alloc(HUGE), rangeErr);
assert.throws(() => Buffer.allocUnsafe(HUGE), rangeErr);
assert.throws(() => Buffer.allocUnsafeSlow(HUGE), rangeErr);
// concat validates an explicit totalLength only for a non-empty list (an empty list
// short-circuits to an empty Buffer on both runtimes, before any check).
assert.throws(() => Buffer.concat([Buffer.alloc(1)], HUGE), rangeErr);

// --- Invalid sizes keep their existing, distinct errors (not the oversize path). -
assert.throws(() => Buffer.alloc(-1), rangeErr);
assert.throws(() => Buffer.alloc(NaN), rangeErr);
assert.throws(() => Buffer.alloc('10'), { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' });

// --- Regression: ordinary allocations and typed arrays still work, and the guard
//     does not perturb instance identity, prototype, or behavior. -----------------
const small = new Uint8Array(8);
small[0] = 255;
assert.equal(small.length, 8);
assert.equal(small[0], 255);
assert.ok(small instanceof Uint8Array);

const fromArray = new Uint8Array([1, 2, 3]);
assert.deepEqual(Array.from(fromArray), [1, 2, 3]);

const ab = new ArrayBuffer(16);
assert.equal(ab.byteLength, 16);
assert.ok(ab instanceof ArrayBuffer);
const view = new Uint32Array(ab);
assert.equal(view.length, 4);
assert.ok(view.buffer === ab);

const buf = Buffer.alloc(4, 7);
assert.equal(buf.length, 4);
assert.ok(buf instanceof Uint8Array);
assert.deepEqual(Array.from(buf), [7, 7, 7, 7]);
// Fractional sizes still truncate toward zero (Uint8Array semantics), not rejected.
assert.equal(Buffer.alloc(3.9).length, 3);

console.log('oversized-allocation ok');
