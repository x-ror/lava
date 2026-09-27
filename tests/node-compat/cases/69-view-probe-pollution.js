// User code must not be able to teach the typed-array cell probe a wrong layout.
//
// Natives borrow a Uint8Array's bytes by reading the JSC cell directly, and decline
// the fast path for a view over a resizable buffer — whose stored length is not its
// length (see 68-resizable-view-bytes.js). Which mode byte means "fixed length" is
// LEARNED, by constructing probe views through the global Uint8Array and ArrayBuffer.
// Probed lazily, on the first native byte op, that learning ran on whatever those
// globals held by then.
//
// The constructor below answers the probe's "plain small view" with a fixed window
// over a resizable buffer and its "fixed view over a resizable buffer" with a plain
// one, so the probe whitelisted the resizable-fixed mode. Measured with the probe
// unprimed (node 24.21 vs bin/lava):
//
//   decode(fixed [0, 3) window after its buffer shrank to 1 byte)   node ""   lava "abc"
//
// — three bytes read past the end of a one-byte buffer. The runtime now runs the
// probe when it creates the context, before any script, so the steered constructor
// is never consulted. The first native byte op is made WHILE the global is replaced,
// which is what made the lazy probe run on it.
const Real = Uint8Array;
globalThis.Uint8Array = function (a, b, c) {
  // A "plain small view" that is really a fixed window over a resizable buffer.
  if (typeof a === 'number') return new Real(new ArrayBuffer(a, { maxByteLength: a + 8 }), 0, a);
  // The probe's fixed window over its resizable buffer, answered with a plain view.
  if (b === 0 && c === 4) return new Real(8);
  return arguments.length === 1 ? new Real(a) : new Real(a, b, c);
};
const td = new TextDecoder();
td.decode(new Real([0x61]));
globalThis.Uint8Array = Real;

const rab = new ArrayBuffer(4, { maxByteLength: 16 });
new Uint8Array(rab).set([0x61, 0x62, 0x63, 0x64]);
const window = new Uint8Array(rab, 0, 3);
rab.resize(1);
console.log('out-of-bounds window', JSON.stringify(td.decode(window)));
console.log('Buffer.compare', Buffer.compare(window, Buffer.alloc(0)));
