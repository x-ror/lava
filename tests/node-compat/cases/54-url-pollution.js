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

console.log('ok');
