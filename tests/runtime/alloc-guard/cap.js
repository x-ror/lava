// Lava-only allocation-guard test. Driven by scripts/run-alloc-guard-smoke.sh,
// which runs this under `lava` with LAVA_MAX_BUFFER_BYTES set to a tiny ceiling.
//
// This is the test that actually exercises the guard. The node-compat corpus
// (tests/node-compat/cases/34-oversized-allocation.js) can only use sizes above
// 2**53-1, which BOTH V8 and JSC reject via ToIndex *before* allocating — so it
// proves "throws RangeError" but not that the guard itself does anything. Here the
// over-cap sizes are tiny (kilobytes): any engine would happily allocate them, so a
// rejection can only come from the guard. And a clean exit (0) proves the guard
// threw a catchable error instead of letting JSC abort the process. Node does not
// honor LAVA_MAX_BUFFER_BYTES, so this cannot live in the node-vs-lava corpus.
'use strict';
const assert = require('node:assert/strict');

const cap = Number(process.env.LAVA_MAX_BUFFER_BYTES);
assert.ok(
  Number.isFinite(cap) && cap > 0 && cap < 1 << 20,
  'expected a tiny positive LAVA_MAX_BUFFER_BYTES (got ' + process.env.LAVA_MAX_BUFFER_BYTES + ')',
);

// Above the cap but trivially allocatable on any machine — so a throw is the guard,
// not the engine running out of address space.
const overCap = cap + 1024;

function rejects(label, fn) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof RangeError, label + ' must throw RangeError, got: ' + err);
}

// Raw typed arrays / ArrayBuffer: the guard, not Buffer, intercepts these.
rejects('new Uint8Array(overCap)', () => new Uint8Array(overCap));
rejects('new ArrayBuffer(overCap)', () => new ArrayBuffer(overCap));
// Element count scaled by BYTES_PER_ELEMENT: overCap*8 bytes is well past the cap.
rejects('new Float64Array(overCap)', () => new Float64Array(overCap));
if (typeof SharedArrayBuffer === 'function') {
  rejects('new SharedArrayBuffer(overCap)', () => new SharedArrayBuffer(overCap));
}
// Resizable ArrayBuffer: tiny initial length, oversized maxByteLength reservation.
rejects(
  'new ArrayBuffer(8, {maxByteLength: overCap})',
  () => new ArrayBuffer(8, { maxByteLength: overCap }),
);

// Buffer paths: rejected before JSC is asked, keeping Node's coded error.
rejects('Buffer.alloc(overCap)', () => Buffer.alloc(overCap));
rejects('Buffer.allocUnsafe(overCap)', () => Buffer.allocUnsafe(overCap));
rejects('Buffer.concat([..], overCap)', () => Buffer.concat([Buffer.alloc(1)], overCap));

// The cap is not a blanket block: within-cap allocations still work normally.
const ok = new Uint8Array(8);
ok[0] = 42;
assert.equal(ok[0], 42);
assert.ok(ok instanceof Uint8Array);
assert.equal(new ArrayBuffer(16).byteLength, 16);
assert.equal(Buffer.alloc(4, 7).length, 4);
assert.ok(Buffer.alloc(4) instanceof Uint8Array);

// Reaching here (and exiting 0) means every over-cap request threw a *catchable*
// RangeError — the process was never aborted by JSC. The smoke runner asserts both
// this line and the zero exit code.
console.log('alloc-guard cap enforced; process survived');
