// util.parseEnv — parse a .env-format string into an object (Node 21+). Handles the
// `export ` prefix, `#` comment lines, single/double/backtick quotes (only a double-
// quoted value expands an escape, and only `\n` -> newline; single/backtick are fully
// literal; any quote may span lines), inline `#` comments on unquoted values, and
// last-wins on duplicate keys. Char scanner (quotes can span newlines). Pure JS via
// primordials; backs require('node:util').parseEnv. Hidden from the public resolver
// like parse_args.
(function (require, module) {
  'use strict';

  var P = require('primordials');
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeTrim = P.StringPrototypeTrim;

  var CR = 13;
  var LF = 10;
  var SPACE = 32;
  var TAB = 9;
  var HASH = 35; // #
  var EQ = 61; // =
  var DQUOTE = 34; // "
  var SQUOTE = 39; // '
  var BACKTICK = 96; // `
  var BACKSLASH = 92; // \
  var LOWER_N = 110; // n

  function isWs(c) {
    return c === SPACE || c === TAB || c === CR || c === LF;
  }
  function isInlineWs(c) {
    return c === SPACE || c === TAB;
  }

  function parseEnv(content) {
    var result = { __proto__: null };
    if (typeof content !== 'string') return result;
    var i = 0;
    var len = content.length;

    while (i < len) {
      // Skip blank space / newlines between entries.
      while (i < len && isWs(StringPrototypeCharCodeAt(content, i))) i++;
      if (i >= len) break;

      // Comment line.
      if (StringPrototypeCharCodeAt(content, i) === HASH) {
        while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
        continue;
      }

      // Optional `export ` prefix.
      if (StringPrototypeSlice(content, i, i + 7) === 'export ') {
        i += 7;
        while (i < len && isInlineWs(StringPrototypeCharCodeAt(content, i))) i++;
      }

      // Key: up to '=' (a line with no '=' is skipped).
      var keyStart = i;
      while (
        i < len &&
        StringPrototypeCharCodeAt(content, i) !== EQ &&
        StringPrototypeCharCodeAt(content, i) !== LF
      ) {
        i++;
      }
      if (i >= len || StringPrototypeCharCodeAt(content, i) === LF) continue;
      var key = StringPrototypeTrim(StringPrototypeSlice(content, keyStart, i));
      i++; // skip '='

      // Skip inline whitespace before the value.
      while (i < len && isInlineWs(StringPrototypeCharCodeAt(content, i))) i++;

      var value;
      var q = i < len ? StringPrototypeCharCodeAt(content, i) : 0;
      if (q === DQUOTE || q === SQUOTE || q === BACKTICK) {
        // Only a double-quoted value expands an escape, and only `\n` -> newline; every
        // other backslash (including one before the closing quote) is literal, and single/
        // backtick values are fully literal. The matching quote always closes the value,
        // and a quote may span multiple lines.
        var expandNewline = q === DQUOTE;
        i++; // skip opening quote
        var buf = '';
        var segStart = i;
        while (i < len && StringPrototypeCharCodeAt(content, i) !== q) {
          if (
            expandNewline &&
            StringPrototypeCharCodeAt(content, i) === BACKSLASH &&
            i + 1 < len &&
            StringPrototypeCharCodeAt(content, i + 1) === LOWER_N
          ) {
            buf += StringPrototypeSlice(content, segStart, i) + '\n';
            i += 2;
            segStart = i;
          } else {
            i++;
          }
        }
        buf += StringPrototypeSlice(content, segStart, i);
        value = buf;
        if (i < len) i++; // skip closing quote
        // Ignore the rest of the line after a quoted value.
        while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
      } else {
        // Unquoted: up to a newline or a '#' comment; trimmed.
        var valStart = i;
        while (
          i < len &&
          StringPrototypeCharCodeAt(content, i) !== LF &&
          StringPrototypeCharCodeAt(content, i) !== HASH
        ) {
          i++;
        }
        value = StringPrototypeTrim(StringPrototypeSlice(content, valStart, i));
        while (i < len && StringPrototypeCharCodeAt(content, i) !== LF) i++;
      }

      if (key.length > 0) result[key] = value;
    }

    return result;
  }

  module.exports = { parseEnv: parseEnv };
});
