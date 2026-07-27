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
//   J  Array.prototype.push     -> the decoder's code-unit accumulator
//   K  String.prototype.charCodeAt / slice -> BOM stripping
//   L  String.prototype.codePointAt       -> encodeInto's scanner
//   M  String.prototype.toLowerCase / trim -> encoding-label normalization
//   N  Object.prototype[label]  -> a forged encoding from the label table
//   O  Object.prototype.fatal   -> every decoder silently became fatal
//
// Errors are compared by name, not message: Lava's invalid-label RangeError
// message still differs from Node's ERR_ENCODING_NOT_SUPPORTED text (a known
// gap, tracked separately from this hardening).

function underPollution(setup, teardown, run) {
  const saved = {};
  setup(saved);
  let out;
  try {
    out = run();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    teardown(saved);
  }
  return out;
}

// --- H: poisoned Function.prototype.apply, through url.js and directly -------

console.log(
  'H1',
  underPollution(
    (s) => {
      s.v = Function.prototype.apply;
      Function.prototype.apply = function () {
        return 'a';
      };
    },
    (s) => {
      Function.prototype.apply = s.v;
    },
    () => new URL('http://%C3%BCber.example/').href,
  ),
);

console.log(
  'H2',
  underPollution(
    (s) => {
      s.v = Function.prototype.apply;
      Function.prototype.apply = function () {
        return 'a';
      };
    },
    (s) => {
      Function.prototype.apply = s.v;
    },
    () => new URL('http://example.com/?a=%C3%BCber').searchParams.get('a'),
  ),
);

// utf-16le never takes the native Buffer fast path, so this is the decoder's
// own JS code-unit loop plus unitsToString.
console.log(
  'H3',
  underPollution(
    (s) => {
      s.v = Function.prototype.apply;
      Function.prototype.apply = function () {
        return 'a';
      };
    },
    (s) => {
      Function.prototype.apply = s.v;
    },
    () =>
      JSON.stringify(
        new TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde, 0x41, 0x00])),
      ),
  ),
);

console.log(
  'H4',
  underPollution(
    (s) => {
      s.v = Function.prototype.apply;
      Function.prototype.apply = function () {
        return 'a';
      };
    },
    (s) => {
      Function.prototype.apply = s.v;
    },
    () => Array.from(new TextEncoder().encode('ü€😀')).join(','),
  ),
);

// --- I: replaced String.fromCharCode ----------------------------------------

console.log(
  'I1',
  underPollution(
    (s) => {
      s.v = String.fromCharCode;
      String.fromCharCode = () => 'PWNED';
    },
    (s) => {
      String.fromCharCode = s.v;
    },
    () => new URL('http://%C3%BCber.example/').href,
  ),
);

console.log(
  'I2',
  underPollution(
    (s) => {
      s.v = String.fromCharCode;
      String.fromCharCode = () => 'PWNED';
    },
    (s) => {
      String.fromCharCode = s.v;
    },
    () => JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x80, 0xe9]))),
  ),
);

// --- J: poisoned Array.prototype.push (the code-unit accumulator) -----------

console.log(
  'J',
  underPollution(
    (s) => {
      s.v = Array.prototype.push;
      Array.prototype.push = function () {
        return 0;
      };
    },
    (s) => {
      Array.prototype.push = s.v;
    },
    () =>
      JSON.stringify(
        new TextDecoder('utf-16le').decode(new Uint8Array([0x3d, 0xd8, 0x00, 0xde, 0x41, 0x00])),
      ),
  ),
);

// --- K: poisoned String.prototype.charCodeAt / slice (BOM stripping) --------

console.log(
  'K1',
  underPollution(
    (s) => {
      s.v = String.prototype.charCodeAt;
      String.prototype.charCodeAt = () => 0xfeff;
    },
    (s) => {
      String.prototype.charCodeAt = s.v;
    },
    () => JSON.stringify(new TextDecoder('windows-1252').decode(new Uint8Array([0x41, 0x42]))),
  ),
);

console.log(
  'K2',
  underPollution(
    (s) => {
      s.v = String.prototype.slice;
      String.prototype.slice = () => 'PWNED';
    },
    (s) => {
      String.prototype.slice = s.v;
    },
    () =>
      JSON.stringify(
        new TextDecoder('utf-16le').decode(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])),
      ),
  ),
);

// --- L: poisoned String.prototype.codePointAt (encodeInto's scanner) --------

console.log(
  'L',
  underPollution(
    (s) => {
      s.v = String.prototype.codePointAt;
      String.prototype.codePointAt = () => 0x41;
    },
    (s) => {
      String.prototype.codePointAt = s.v;
    },
    () => {
      const dest = new Uint8Array(8);
      const r = new TextEncoder().encodeInto('a😀b', dest);
      return JSON.stringify(r) + ' ' + Array.from(dest).join(',');
    },
  ),
);

// --- M: poisoned label normalization ----------------------------------------
// The label is already lower-case and untrimmed so that Node resolves it on the
// exact-match path: Node's getEncodingFromLabel only reaches a (pollutable)
// toLowerCase as a fallback, and never trims at all. Lava normalizes every
// label, so before the hardening both vectors forged the encoding.

console.log(
  'M1',
  underPollution(
    (s) => {
      s.v = String.prototype.toLowerCase;
      String.prototype.toLowerCase = () => 'utf-8';
    },
    (s) => {
      String.prototype.toLowerCase = s.v;
    },
    () => new TextDecoder('utf-16le').encoding,
  ),
);

console.log(
  'M2',
  underPollution(
    (s) => {
      s.v = String.prototype.trim;
      String.prototype.trim = () => 'utf-8';
    },
    (s) => {
      String.prototype.trim = s.v;
    },
    () => new TextDecoder('utf-16le').encoding,
  ),
);

// --- N: Object.prototype as a source of forged encoding labels --------------

console.log(
  'N1',
  underPollution(
    () => {
      Object.prototype.evil = 'utf-8';
    },
    () => {
      delete Object.prototype.evil;
    },
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
      return 'THREW:' + e.name;
    }
  })(),
);
console.log(
  'N3',
  (() => {
    try {
      return new TextDecoder('__proto__').encoding;
    } catch (e) {
      return 'THREW:' + e.name;
    }
  })(),
);

// --- O: Object.prototype.fatal / ignoreBOM leaking into default options -----

console.log(
  'O1',
  underPollution(
    () => {
      Object.prototype.fatal = true;
    },
    () => {
      delete Object.prototype.fatal;
    },
    () => new TextDecoder().fatal,
  ),
);

console.log(
  'O2',
  underPollution(
    () => {
      Object.prototype.ignoreBOM = true;
    },
    () => {
      delete Object.prototype.ignoreBOM;
    },
    () => JSON.stringify(new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x42]))),
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

console.log('ok');
