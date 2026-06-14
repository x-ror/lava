// process.exit() / process.exitCode (issue #102). This case stays exit-0 (the
// Node-only smoke step requires it), so it asserts the catchable behaviors:
// process.exitCode round-trips, exit is a function, and exit(NaN) throws
// ERR_OUT_OF_RANGE. The runtime-level "exit() with no arg uses process.exitCode"
// is verified separately (see the PR): `process.exitCode = 7; process.exit()`
// exits 7 on both Node and Lava.
const assert = require('node:assert/strict');

assert.equal(typeof process.exit, 'function');

// A NaN code is a RangeError (ERR_OUT_OF_RANGE), not a silent exit.
assert.throws(
  () => process.exit(NaN),
  (e) => e.code === 'ERR_OUT_OF_RANGE',
);

// process.exitCode is a readable/writable property (the runtime drains with it).
process.exitCode = 3;
assert.equal(process.exitCode, 3);
process.exitCode = 0; // keep this case's own exit status at 0

console.log('ok');
