// node:console — the console object is a global in this runtime; this module exposes it
// under the module specifier (Node parity: require('node:console') gives the console
// methods). The Console constructor for custom-stream consoles is not yet provided.
(function (require, module, exports) {
  'use strict';
  module.exports = console;
});
