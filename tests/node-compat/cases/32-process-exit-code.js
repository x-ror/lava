// process.exit() / process.exitCode (issue #102). The compat runner compares exit
// status too, so this case deliberately exits non-zero identically on Node and
// Lava: process.exit() with no argument must use process.exitCode as the default
// (here 7), not 0. Also checks that process.exit(NaN) throws ERR_OUT_OF_RANGE.
const assert = require('node:assert/strict');

// A NaN code is a RangeError (ERR_OUT_OF_RANGE), not a silent exit.
assert.throws(
  () => process.exit(NaN),
  (e) => e.code === 'ERR_OUT_OF_RANGE',
);

console.log('exit-code-test');

// No-argument exit() defaults to process.exitCode → the process exits 7.
process.exitCode = 7;
process.exit();
