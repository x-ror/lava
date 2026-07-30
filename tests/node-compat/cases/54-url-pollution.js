// URL construction must survive a poisoned Array/String prototype and a poisoned
// Object.prototype / replaced global — Node's parser is native C++ (immune) and
// Lava's is JS routed through primordials + module-eval-captured globals, so both
// must produce the correct URL. This is a real differential oracle (not Lava-only)
// precisely because Node also passes: each case poisons one axis, runs one URL
// operation, restores, and prints the result, so a regression in the hardening
// shows up as a diff against Node.
//
// Each vector below is one that DID corrupt Lava before the url.js hardening:
//   A  Array.prototype.slice   -> relative-URL base path was mis-resolved
//   B  Array.prototype.at      -> IPv4 normalization silently disabled
//   C  String.prototype.normalize -> host substituted by the attacker
//   F  String.prototype.toLowerCase -> dot-segment removal skipped
//   G  Object.prototype[key]   -> a real port silently dropped
//   E  replaced decodeURIComponent -> fileURLToPath diverted

function underPollution(setup, teardown, run) {
  const saved = {};
  setup(saved);
  let out;
  try {
    out = run();
  } catch (e) {
    out = 'THREW:' + e.message;
  } finally {
    teardown(saved);
  }
  return out;
}

console.log(
  'A',
  underPollution(
    (s) => {
      s.v = Array.prototype.slice;
      Array.prototype.slice = () => ['PWNED'];
    },
    (s) => {
      Array.prototype.slice = s.v;
    },
    () => new URL('c/d', 'http://a.b/x/y/z').href,
  ),
);

console.log(
  'B',
  underPollution(
    (s) => {
      s.v = Array.prototype.at;
      Array.prototype.at = () => 'ZZZ';
    },
    (s) => {
      Array.prototype.at = s.v;
    },
    () => new URL('http://0300.0250.0.1/').href,
  ),
);

console.log(
  'C',
  underPollution(
    (s) => {
      s.v = String.prototype.normalize;
      String.prototype.normalize = () => 'evil.example';
    },
    (s) => {
      String.prototype.normalize = s.v;
    },
    () => new URL('http://über.example/').href,
  ),
);

console.log(
  'F',
  underPollution(
    (s) => {
      s.v = String.prototype.toLowerCase;
      String.prototype.toLowerCase = () => 'evil';
    },
    (s) => {
      String.prototype.toLowerCase = s.v;
    },
    () => new URL('http://example.com/a/../b').href,
  ),
);

console.log(
  'G',
  underPollution(
    () => {
      Object.prototype.foo = 8080;
    },
    () => {
      delete Object.prototype.foo;
    },
    () => new URL('foo://h:8080/p').href,
  ),
);

console.log(
  'E',
  underPollution(
    (s) => {
      s.v = globalThis.decodeURIComponent;
      globalThis.decodeURIComponent = () => '/etc/passwd';
    },
    (s) => {
      globalThis.decodeURIComponent = s.v;
    },
    () => require('node:url').fileURLToPath('file:///tmp/x%20y'),
  ),
);

// --- RegExp.prototype.exec, the validator carrier -------------------------
//
// `RegExp.prototype.exec` is a writable data property, and the spec's RegExpExec
// abstract operation re-reads it off the RECEIVER before falling back to the
// builtin — so a plain assignment steers `re.test(...)` too, including a `test`
// captured pristine at module-eval. url.js's host and path validators are
// therefore only sound if they never route through a live regex method at all.
//
// node's URL is native C++ and is immune, so these are true differential vectors.
//
// The hosts here are lowercase or numeric ON PURPOSE. An uppercase host reaches
// `domainToASCII`, whose `/[。．｡]/g` replaceAll is a GLOBAL regex — a forged
// non-empty match never advances lastIndex, so it spins instead of answering.
// That residue is real, is on the network path, and is tracked in ROADMAP; a
// vector that hangs would pin nothing here.
const poisonExec = [
  (s) => {
    s.exec = RegExp.prototype.exec;
    const forged = ['forged'];
    forged.index = 0;
    forged.input = '';
    RegExp.prototype.exec = function () {
      return forged;
    };
  },
  (s) => {
    RegExp.prototype.exec = s.exec;
  },
];

// X1: `endsInANumber` decides whether a host is parsed as IPv4. Steered true,
// '4x' reads as numeric and parseInt('4x', 10) is 4, so the host silently becomes
// http://1.2.3.4/ — a host SUBSTITUTION, the same class as the constructor vector
// above.
console.log(
  'X1',
  underPollution(...poisonExec, () => new URL('http://1.2.3.4x/').href),
);

// X2: the %2f path-traversal check, in the NEGATIVE direction. A positive case
// throws either way and would be decorative; this one discriminates, because a
// steered validator makes a legitimate path look encoded and throws where node
// returns a path.
console.log(
  'X2',
  underPollution(...poisonExec, () => require('node:url').fileURLToPath('file:///tmp/x')),
);

// X3: parseIPv4Number's radix validation — octal and dotted-quad shapes, where a
// steered digit check would accept a non-numeric label or reject a valid one.
console.log(
  'X3',
  underPollution(...poisonExec, () => new URL('http://0300.0250.0.1/').href),
);
console.log(
  'X4',
  underPollution(...poisonExec, () => new URL('http://1.2.3.4/').href),
);

// X5: relative resolution, which walks the leading-slash and tab/newline guards.
console.log(
  'X5',
  underPollution(...poisonExec, () => new URL('/a', 'http://h/b').href),
);

console.log('ok');
