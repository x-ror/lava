// Oversized typed-array / ArrayBuffer allocation guard.
//
// Unlike V8 — which throws a catchable RangeError when an in-range allocation
// cannot be satisfied — JavaScriptCore aborts the whole process once a request
// exceeds what it can allocate. The Buffer layer (js/internal/buffer.js) already
// caps its own allocations, but raw `new Uint8Array(huge)` / `new ArrayBuffer(huge)`
// from user code bypass it. This prelude wraps the global ArrayBuffer,
// SharedArrayBuffer, and TypedArray constructors so an oversized length throws a
// catchable RangeError *before* JSC attempts (and aborts on) the allocation.
//
// Each constructor is replaced with a Proxy whose `construct` trap validates the
// length form, then delegates via Reflect.construct(target, args, newTarget). The
// instances produced are genuine typed arrays / buffers, so every instance and
// static operation stays native-speed, `instanceof` and `.constructor.name` keep
// working, and `@@species`-driven internal ops (subarray/slice/map/filter) run on
// the original constructor — only an explicit `new TypedArray(n)` pays the check.
// Native typed arrays built straight from existing bytes
// (JSObjectMakeTypedArrayWithBytesNoCopy in the Odin layer) never go through these
// constructors and are unaffected.
//
// Accepted trade-offs (these apply to every wrapped global — ArrayBuffer and
// SharedArrayBuffer as well as the TypedArrays):
//   1. `(new Uint8Array(n)).constructor === Uint8Array` is false — the instance's
//      constructor is the original, the global is the Proxy. No Node API relies on
//      that reference identity (robust code uses `instanceof` / `ArrayBuffer.isView`),
//      and rewriting the prototype constructors would push every internal
//      subarray/slice through the trap, so the guard leaves them alone.
//   2. The unwrapped constructor stays reachable as `Uint8Array.prototype.constructor`
//      (the Proxy installs no `get` trap), so `new (someInstance.constructor)(huge)`
//      can still reach JSC unguarded. This is deliberate: it is the very hatch the
//      Buffer module uses to extend the original constructor at native speed (see
//      buffer.js). The guard targets the common `new TypedArray(n)` / `new
//      ArrayBuffer(n)` forms, not adversarial bypass — lava is not a sandbox.
//
// Factory shape mirrors the other internal preludes: (globalThis, maxAllocBytes).
(function (globalThis, maxAllocBytes) {
  'use strict';

  // The byte ceiling, supplied by native (max_buffer_alloc_bytes in buffer.odin).
  // Fall back to 4 GiB if the binding is missing or nonsensical so the guard never
  // disables itself silently.
  var MAX =
    typeof maxAllocBytes === 'number' && isFinite(maxAllocBytes) && maxAllocBytes > 0
      ? maxAllocBytes
      : 4294967296;

  // A catchable RangeError carrying JavaScriptCore's own out-of-memory wording —
  // the same error Bun (also JSC) throws for an over-cap allocation that still
  // passes ToIndex (e.g. `new Uint8Array(2**40)`). Matching the engine's message
  // keeps the guard indistinguishable from a native rejection. ToIndex failures
  // (length > 2**53-1) keep JSC's distinct "Invalid …" message because those are
  // left to the native constructor below.
  function makeRangeError() {
    return new RangeError('Out of memory');
  }

  function wrap(name, bytesPerElement, isArrayBufferLike) {
    var Original = globalThis[name];
    if (typeof Original !== 'function') return;
    var handler = {
      construct: function (target, args, newTarget) {
        var first = args.length > 0 ? args[0] : undefined;
        // Only the numeric length form allocates here. An object first argument
        // (ArrayBuffer/iterable/array-like) either views existing memory or copies
        // a bounded source — leave those to the native constructor. A negative,
        // zero, NaN, or Infinity length is left to the native constructor too, so
        // its existing (catchable) error and message are preserved unchanged.
        if (typeof first === 'number' && isFinite(first) && first > 0) {
          if (first * bytesPerElement > MAX) throw makeRangeError();
        }
        // A resizable ArrayBuffer / growable SharedArrayBuffer reserves up to the
        // options-bag maxByteLength even when the initial length is tiny, and JSC
        // (like Bun) rejects an oversized reservation. Node currently allows it, but
        // validating here keeps that reservation from reaching — and aborting — JSC.
        // Only the *Buffer constructors take this options bag; a TypedArray's second
        // argument is a numeric byteOffset, which the typeof-object check skips.
        if (isArrayBufferLike && args.length > 1) {
          var opts = args[1];
          if (opts !== null && typeof opts === 'object') {
            var mbl = opts.maxByteLength;
            if (typeof mbl === 'number' && isFinite(mbl) && mbl > MAX) throw makeRangeError();
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
    };
    globalThis[name] = new Proxy(Original, handler);
  }

  // ArrayBuffer/SharedArrayBuffer take a byte length directly (1 byte per unit) and
  // accept a { maxByteLength } options bag for the resizable/growable forms.
  wrap('ArrayBuffer', 1, true);
  if (typeof globalThis.SharedArrayBuffer === 'function') wrap('SharedArrayBuffer', 1, true);

  // TypedArrays take an element count; scale by BYTES_PER_ELEMENT to bytes.
  var typedArrays = [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
  ];
  for (var i = 0; i < typedArrays.length; i++) {
    var ctor = globalThis[typedArrays[i]];
    if (typeof ctor === 'function') wrap(typedArrays[i], ctor.BYTES_PER_ELEMENT || 1, false);
  }
});
