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
// Accepted trade-off: `(new Uint8Array(n)).constructor === Uint8Array` is false
// (the instance's constructor is the original, the global is the Proxy). No Node
// API relies on that reference identity — robust code uses `instanceof` /
// `ArrayBuffer.isView` — so the guard does not bother rewriting prototype
// constructors (which would push every internal subarray/slice through the trap).
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

  // A plain RangeError, matching V8's shape for `new TypedArray(tooBig)` /
  // `new ArrayBuffer(tooBig)` (which carry no Node error code).
  function makeRangeError() {
    return new RangeError('Allocation size exceeds the maximum of ' + MAX + ' bytes');
  }

  function wrap(name, bytesPerElement) {
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
        return Reflect.construct(target, args, newTarget);
      },
    };
    globalThis[name] = new Proxy(Original, handler);
  }

  // ArrayBuffer/SharedArrayBuffer take a byte length directly (1 byte per unit).
  wrap('ArrayBuffer', 1);
  if (typeof globalThis.SharedArrayBuffer === 'function') wrap('SharedArrayBuffer', 1);

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
    if (typeof ctor === 'function') wrap(typedArrays[i], ctor.BYTES_PER_ELEMENT || 1);
  }
});
