// node:process — export the intrinsic process object captured at context init.
//
// Params: (require, module, exports, intrinsic) — `intrinsic` is natives['process'],
//   the real process object placed there by install_internal_modules before user
//   code runs.
// Returns: the process object (same reference as the original globalThis.process).
// Node: require('node:process') is the intrinsic regardless of global mutation
//   (node 24, verified). When the global is untouched, require === process.
// Deviates: none.
//
// Never re-read the global. A dependency that reassigns or deletes
// globalThis.process before the first require('node:process') would otherwise
// poison every later consumer of the builtin (issue #247). Fail closed if the
// natives channel did not hand us the object — exporting undefined would look
// like "not a builtin" and fall through to MODULE_NOT_FOUND.
(function (require, module, exports, intrinsic) {
  'use strict';
  if (intrinsic == null) {
    throw new Error('node:process intrinsic missing at context init');
  }
  module.exports = intrinsic;
});
