// node:path/win32 — the Windows path variant, surfaced under its own specifier
// (Node: require('node:path/win32')). See path_posix.js.
(function (require, module) {
  'use strict';
  module.exports = require('path').win32;
});
