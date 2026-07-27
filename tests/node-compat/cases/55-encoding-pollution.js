// TextEncoder/TextDecoder must survive a poisoned prototype or replaced global —
// Node's codecs are native C++ (immune) and Lava's are JS routed through
// primordials + module-eval-captured globals, so both must produce the same
// bytes and the same text. A real differential oracle (not Lava-only): Node
// passes natively, so a regression in the encoding.js hardening shows up as a
// diff against Node.
//
// url.js delegates every percent-decode and host-decode to TextDecoder, so the
// `new URL(...)` cases below are MODULE-BOUNDARY vectors: url.js was already
// hardened, but a poisoned intrinsic still reached it through encoding.js.
//
//   H  Function.prototype.apply -> String.fromCharCode.apply rewrote the decoded
//      host: new URL('http://%C3%BCber.example/') became http://a/
//   I  String.fromCharCode      -> same carrier, replaced statically
//   J  Array.prototype.push     -> the decoder's code-unit accumulator, on all
//                                  four decode paths and every flush/error site
//   K  String.prototype.charCodeAt / slice -> BOM stripping
//   L  String.prototype.codePointAt       -> encodeInto's scanner
//   M  String.prototype.toLowerCase / trim -> encoding-label normalization
//   N  Object.prototype[label]  -> a forged encoding from the label table
//   O  Object.prototype.fatal   -> every decoder silently became fatal
//   P  replaced free globals    -> Uint8Array / ArrayBuffer / ArrayBuffer.isView /
//                                  TypeError / RangeError / Object.defineProperty
//   Q  the >0x2000 chunked unitsToString branch (ArrayPrototypeSlice+ReflectApply)
//   R  Buffer.from / Buffer.prototype.toString / the String global underneath —
//      the encoding->buffer boundary, one layer below the url->encoding one
//
// Errors are compared by name AND code, so an error-identity divergence cannot
// hide behind a matching class.

function underPollution(setup, teardown, run) {
  const saved = {};
  setup(saved);
  let out;
  try {
    out = run();
  } catch (e) {
    out = 'THREW:' + e.name + (e.code === undefined ? '' : ':' + e.code);
  } finally {
    teardown(saved);
  }
  return out;
}

// Save/restore one property, as a [setup, teardown] pair.
function poison(target, key, value) {
  return [
    (s) => {
      s.had = Object.prototype.hasOwnProperty.call(target, key);
      s.v = target[key];
      target[key] = value;
    },
    (s) => {
      if (s.had) target[key] = s.v;
      else delete target[key];
    },
  ];
}

// Held before any vector runs, so a test that replaces the global still has a
// genuine typed array to hand in (Node validates `dest` by brand, and that
// error's identity is a separate, pre-existing gap this case must not depend on).
const RealU8 = Uint8Array;

const U16_SMILE = [0x3d, 0xd8, 0x00, 0xde, 0x41, 0x00]; // 😀A
const APPLY_STUB = function () {
  return 'a';
};

// A >0x2000-code-unit input, so unitsToString takes its chunked branch.
const BIG_LATIN = new Uint8Array(9000);
for (let i = 0; i < BIG_LATIN.length; i++) BIG_LATIN[i] = 0x41 + (i % 26);
function bigDigest(s) {
  return s.length + ':' + s.charCodeAt(0) + ':' + s.charCodeAt(8192) + ':' + s.charCodeAt(8999);
}

// --- H: poisoned Function.prototype.apply, through url.js and directly -------

console.log(
  'H1',
  underPollution(
    ...poison(Function.prototype, 'apply', APPLY_STUB),
    () => new URL('http://%C3%BCber.example/').href,
  ),
);

// The fatal decoder is what url.js percentDecodeHostStrict uses, and unlike the
// lenient one it never takes the native Buffer fast path.
console.log(
  'H2',
  underPollution(...poison(Function.prototype, 'apply', APPLY_STUB), () =>
    JSON.stringify(
      new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array([0xc3, 0xbc, 0x62, 0x65, 0x72]),
      ),
    ),
  ),
);

// utf-16le never takes the native Buffer fast path either.
console.log(
  'H3',
  underPollution(...poison(Function.prototype, 'apply', APPLY_STUB), () =>
    JSON.stringify(new TextDecoder('utf-16le').decode(new Uint8Array(U16_SMILE))),
  ),
);

console.log(
  'H4',
  underPollution(...poison(Function.prototype, 'apply', APPLY_STUB), () =>
    Array.from(new TextEncoder().encode('ü€😀')).join(','),
  ),
);

// --- I: replaced String.fromCharCode ----------------------------------------

console.log(
  'I1',
  underPollution(
    ...poison(String, 'fromCharCode', () => 'PWNED'),
    () => new URL('http://%C3%BCber.example/').href,
  ),
);

console.log(
  'I2',
  underPollution(...poison(String, 'fromCharCode', () => 'PWNED'), () =>
    JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x80, 0xe9]))),
  ),
);

// --- J: poisoned Array.prototype.push, on every decode path -----------------

const PUSH_STUB = function () {
  return 0;
};

console.log(
  'J1',
  underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
    JSON.stringify(new TextDecoder('utf-16le').decode(new Uint8Array(U16_SMILE))),
  ),
);

// fatal utf-8: ASCII push + pushCodePoint BMP + pushCodePoint surrogate pair
console.log(
  'J2',
  underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
    JSON.stringify(
      new TextDecoder('utf-8', { fatal: true }).decode(
        new Uint8Array([0x41, 0xc3, 0xbc, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]),
      ),
    ),
  ),
);

// streaming utf-8: invalid lead, bad-continuation re-process, final-flush U+FFFD
console.log(
  'J3',
  underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () => {
    const d = new TextDecoder();
    return JSON.stringify(
      d.decode(new Uint8Array([0x41, 0xff, 0xe2, 0x41]), { stream: true }) +
        d.decode(new Uint8Array([0xe2, 0x82]), { stream: true }) +
        d.decode(),
    );
  }),
);

console.log(
  'J4',
  underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
    JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x80, 0xe9]))),
  ),
);

// utf-16le error and flush sites: lone low, orphan high, odd trailing byte
console.log(
  'J5',
  underPollution(...poison(Array.prototype, 'push', PUSH_STUB), () =>
    JSON.stringify(
      [
        [0x00, 0xdc, 0x41, 0x00],
        [0x3d, 0xd8, 0x41, 0x00],
        [0x41, 0x00, 0x42],
        [0x3d, 0xd8],
      ]
        .map((b) => new TextDecoder('utf-16le').decode(new Uint8Array(b)))
        .join('|'),
    ),
  ),
);

// --- K: poisoned String.prototype.charCodeAt / slice (BOM stripping) --------

console.log(
  'K1',
  underPollution(...poison(String.prototype, 'charCodeAt', () => 0xfeff), () =>
    JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]))),
  ),
);

console.log(
  'K2',
  underPollution(...poison(String.prototype, 'slice', () => 'PWNED'), () =>
    JSON.stringify(
      new TextDecoder('utf-16le').decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])),
    ),
  ),
);

// --- L: poisoned String.prototype.codePointAt (encodeInto's scanner) --------

console.log(
  'L',
  underPollution(...poison(String.prototype, 'codePointAt', () => 0x41), () => {
    const dest = new Uint8Array(8);
    const r = new TextEncoder().encodeInto('a😀b', dest);
    return JSON.stringify(r) + ' ' + Array.from(dest).join(',');
  }),
);

// --- M: poisoned label normalization ----------------------------------------
// The label is already lower-case and untrimmed so that Node resolves it on the
// exact-match path: Node's getEncodingFromLabel tries an exact Map hit first and
// only then falls back to a (pollutable) toLowerCase. It never calls
// String.prototype.trim — it has its own ASCII-only trimAsciiWhitespace, because
// String.prototype.trim would also strip non-ASCII whitespace. Lava normalizes
// every label, so before the hardening both vectors forged the encoding.

console.log(
  'M1',
  underPollution(
    ...poison(String.prototype, 'toLowerCase', () => 'utf-8'),
    () => new TextDecoder('utf-16le').encoding,
  ),
);

console.log(
  'M2',
  underPollution(
    ...poison(String.prototype, 'trim', () => 'utf-8'),
    () => new TextDecoder('utf-16le').encoding,
  ),
);

// --- N: Object.prototype as a source of forged encoding labels --------------

console.log(
  'N1',
  underPollution(
    ...poison(Object.prototype, 'evil', 'utf-8'),
    () => new TextDecoder('evil').encoding,
  ),
);

// Same axis without any pollution at all: these label names resolve on a plain
// object's prototype chain, so a non-null-prototype table accepts them.
console.log(
  'N2',
  (() => {
    try {
      return new TextDecoder('constructor').encoding;
    } catch (e) {
      return 'THREW:' + e.name + ':' + e.code;
    }
  })(),
);
console.log(
  'N3',
  (() => {
    try {
      return new TextDecoder('__proto__').encoding;
    } catch (e) {
      return 'THREW:' + e.name + ':' + e.code;
    }
  })(),
);

// --- O: Object.prototype.fatal / ignoreBOM leaking into default options -----

console.log(
  'O1',
  underPollution(...poison(Object.prototype, 'fatal', true), () => new TextDecoder().fatal),
);

console.log(
  'O2',
  underPollution(...poison(Object.prototype, 'ignoreBOM', true), () =>
    JSON.stringify(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42]))),
  ),
);

// A decoder that IS fatal must still throw while Object.prototype is clean.
console.log(
  'O3',
  (() => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]));
    } catch (e) {
      return 'THREW:' + e.name + ':' + e.code;
    }
  })(),
);

// Object.prototype.get turns every plain property descriptor into an accessor
// descriptor — reachable from a JSON merge gadget, {"__proto__":{"get":1}}.
console.log(
  'O4',
  underPollution(...poison(Object.prototype, 'get', 1), () => {
    const d = new TextDecoder('utf-16le');
    return d.encoding + '/' + d.fatal + '/' + new URL('http://%C3%BCber.example/').hostname;
  }),
);

console.log(
  'O5',
  underPollution(...poison(Object.prototype, 'enumerable', true), () =>
    JSON.stringify(new TextDecoder()),
  ),
);

// --- P: replaced free globals (invisible to the primordials ratchet) --------

console.log(
  'P1',
  underPollution(
    ...poison(globalThis, 'Uint8Array', function () {
      return { length: 3 };
    }),
    () =>
      Array.from(new TextEncoder().encode('AB')).join(',') +
      '/' +
      JSON.stringify(new TextEncoder().encodeInto('ab', new RealU8(4))),
  ),
);

console.log(
  'P2',
  underPollution(...poison(globalThis, 'ArrayBuffer', function () {}), () =>
    JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]).buffer)),
  ),
);

console.log(
  'P3',
  underPollution(...poison(ArrayBuffer, 'isView', () => false), () =>
    JSON.stringify(
      new TextDecoder('windows-1252').decode(new DataView(new Uint8Array([0x41, 0x42]).buffer)),
    ),
  ),
);

console.log(
  'P4',
  underPollution(
    ...poison(globalThis, 'TypeError', function Impostor(m) {
      this.name = 'PWNED';
      this.message = m;
    }),
    () => {
      const names = [];
      const grab = (fn) => {
        try {
          fn();
          names.push('no-throw');
        } catch (e) {
          names.push(e.name);
        }
      };
      grab(() => new TextDecoder().decode(123));
      grab(() => TextEncoder());
      grab(() => new TextEncoder().encodeInto('a', {}));
      grab(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])));
      return names.join(',');
    },
  ),
);

console.log(
  'P5',
  underPollution(
    ...poison(globalThis, 'RangeError', function Impostor(m) {
      this.name = 'PWNED';
      this.message = m;
    }),
    () => {
      try {
        new TextDecoder('no-such-encoding');
        return 'no-throw';
      } catch (e) {
        return e.name;
      }
    },
  ),
);

console.log(
  'P6',
  underPollution(
    ...poison(Object, 'defineProperty', function (o, k, d) {
      o[k] = d && d.value;
      return o;
    }),
    () => {
      const d = new TextDecoder('utf-16le');
      return d.encoding + '/' + d.fatal + '/' + d.decode(new Uint8Array([0x41, 0x00]));
    },
  ),
);

// --- Q: the >0x2000 chunked unitsToString branch ----------------------------

console.log('Q1', bigDigest(new TextDecoder('windows-1252').decode(BIG_LATIN)));

console.log(
  'Q2',
  underPollution(...poison(Function.prototype, 'apply', APPLY_STUB), () =>
    bigDigest(new TextDecoder('windows-1252').decode(BIG_LATIN)),
  ),
);

console.log(
  'Q3',
  underPollution(...poison(Array.prototype, 'slice', () => ['P'.charCodeAt(0)]), () =>
    bigDigest(new TextDecoder('windows-1252').decode(BIG_LATIN)),
  ),
);

// --- R: the encoding -> buffer boundary -------------------------------------

console.log(
  'R1',
  underPollution(...poison(Buffer.prototype, 'toString', () => 'PWNED'), () =>
    JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
  ),
);

console.log(
  'R2',
  underPollution(
    ...poison(Buffer, 'from', () => new Uint8Array([0x50, 0x57])),
    () =>
      Array.from(new TextEncoder().encode('AB')).join(',') +
      '/' +
      JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
  ),
);

// Buffer resolves its encoding NAME through the String global and
// String.prototype.toLowerCase, so those reach a hardened TextDecoder from below.
console.log(
  'R3',
  underPollution(
    ...poison(globalThis, 'String', () => 'PWNED'),
    () =>
      Array.from(new TextEncoder().encode('AB')).join(',') +
      '/' +
      JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
  ),
);

console.log(
  'R4',
  underPollution(
    ...poison(String.prototype, 'toLowerCase', () => 'pwned'),
    () =>
      Array.from(new TextEncoder().encode('AB')).join(',') +
      '/' +
      JSON.stringify(new TextDecoder().decode(new Uint8Array([0x41, 0x42]))),
  ),
);

console.log(
  'R5',
  underPollution(...poison(Object.prototype, 'utf8', 'hex'), () =>
    Array.from(new TextEncoder().encode('AB')).join(','),
  ),
);

// --- S: the accessor axis on the code-unit accumulator ----------------------
// An accessor at Array.prototype[0] intercepts a store into a plain array's
// index 0 — a strictly weaker primitive than replacing push, and invisible to
// the primordials ratchet. Only the decoder's own accumulator is exercised here;
// url.js still builds its percent-decode byte arrays on plain arrays.

console.log(
  'S',
  (() => {
    let intercepted = 0;
    Object.defineProperty(Array.prototype, 0, {
      configurable: true,
      get() {
        return 0x42;
      },
      set() {
        intercepted++;
      },
    });
    let out;
    try {
      out = [
        new TextDecoder('utf-16le').decode(new Uint8Array([0x41, 0x00, 0x42, 0x00])),
        new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x80])),
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0x42, 0x43])),
      ].join('|');
    } catch (e) {
      out = 'THREW:' + e.name;
    } finally {
      delete Array.prototype[0];
    }
    return out + ' intercepted=' + intercepted;
  })(),
);

console.log('ok');
