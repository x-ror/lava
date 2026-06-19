// node:process — the process object is a global in this runtime; this module just
// exposes it under the module specifier (Node parity: require('node:process') === the
// global process).
(function (require, module, exports) {
  'use strict';
  module.exports = process;
});
