// util.parseArgs — a faithful port of Node's lib/internal/util/parse_args. Tokenizes an
// argv array against an options config (short/long, =value, -abc groups, string vs
// boolean, multiple, defaults, -- terminator) and returns { values, positionals[, tokens] }.
// strict mode (default) validates unknown options and option/value mismatches with Node's
// error codes. Pure JS; backs require('node:util').parseArgs.
//
// Uses primordials throughout (like Node's internals) so a script that mutates a shared
// prototype — Array.prototype.push, Object.prototype.hasOwnProperty, … — cannot alter the
// parse.
(function (require, module) {
  'use strict';

  var P = require('primordials');
  var TypeError = P.TypeError;
  var ObjectKeys = P.ObjectKeys;
  var ObjectPrototypeHasOwnProperty = P.ObjectPrototypeHasOwnProperty;
  var ArrayPrototypePush = P.ArrayPrototypePush;
  var ArrayPrototypeShift = P.ArrayPrototypeShift;
  var ArrayPrototypeUnshift = P.ArrayPrototypeUnshift;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeCharAt = P.StringPrototypeCharAt;
  var StringPrototypeIndexOf = P.StringPrototypeIndexOf;
  var StringPrototypeSlice = P.StringPrototypeSlice;

  function objectGetOwn(obj, key) {
    return ObjectPrototypeHasOwnProperty(obj, key) ? obj[key] : undefined;
  }

  function codedError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  function findLongOptionForShort(shortOption, options) {
    var keys = ObjectKeys(options);
    for (var i = 0; i < keys.length; i++) {
      if (options[keys[i]].short === shortOption) return keys[i];
    }
    return shortOption;
  }

  function isOptionLikeValue(value) {
    return (
      typeof value === 'string' && value.length > 1 && StringPrototypeCharCodeAt(value, 0) === 45
    );
  }
  function isLoneShortOption(arg) {
    return (
      arg.length === 2 &&
      StringPrototypeCharCodeAt(arg, 0) === 45 &&
      StringPrototypeCharCodeAt(arg, 1) !== 45
    );
  }
  function isLoneLongOption(arg) {
    return (
      arg.length > 2 &&
      StringPrototypeCharCodeAt(arg, 0) === 45 &&
      StringPrototypeCharCodeAt(arg, 1) === 45 &&
      StringPrototypeIndexOf(arg, '=') === -1
    );
  }
  function isLongOptionAndValue(arg) {
    return (
      arg.length > 2 &&
      StringPrototypeCharCodeAt(arg, 0) === 45 &&
      StringPrototypeCharCodeAt(arg, 1) === 45 &&
      StringPrototypeIndexOf(arg, '=') !== -1
    );
  }
  function isShortGroupHead(arg) {
    return (
      arg.length > 2 &&
      StringPrototypeCharCodeAt(arg, 0) === 45 &&
      StringPrototypeCharCodeAt(arg, 1) !== 45
    );
  }
  function isShortOptionAndValue(arg, options) {
    if (!isShortGroupHead(arg)) return false;
    var opt = objectGetOwn(options, findLongOptionForShort(StringPrototypeCharAt(arg, 1), options));
    return opt !== undefined && opt.type === 'string';
  }
  function isShortOptionGroup(arg, options) {
    if (!isShortGroupHead(arg)) return false;
    // A group only if the first short option is NOT a string option (which would instead
    // consume the rest as its value, handled by isShortOptionAndValue).
    var opt = objectGetOwn(options, findLongOptionForShort(StringPrototypeCharAt(arg, 1), options));
    return opt === undefined || opt.type !== 'string';
  }

  function argsToTokens(args, options, allowNegative) {
    var tokens = [];
    var remaining = ArrayPrototypeSlice(args);
    var index = -1;
    var groupCount = 0;

    while (remaining.length > 0) {
      var arg = ArrayPrototypeShift(remaining);
      var nextArg = remaining[0];
      if (groupCount > 0) {
        groupCount--;
      } else {
        index++;
      }

      // '--' terminates option parsing; the rest are positionals.
      if (arg === '--') {
        ArrayPrototypePush(tokens, { kind: 'option-terminator', index: index });
        for (var r = 0; r < remaining.length; r++) {
          ArrayPrototypePush(tokens, {
            kind: 'positional',
            index: index + 1 + r,
            value: remaining[r],
          });
        }
        break;
      }

      if (isLoneShortOption(arg)) {
        var sLong = findLongOptionForShort(StringPrototypeCharAt(arg, 1), options);
        var sOpt = objectGetOwn(options, sLong);
        var sValue;
        if (sOpt !== undefined && sOpt.type === 'string' && nextArg !== undefined) {
          sValue = ArrayPrototypeShift(remaining);
        }
        ArrayPrototypePush(tokens, {
          kind: 'option',
          name: sLong,
          rawName: arg,
          index: index,
          value: sValue,
          inlineValue: sValue !== undefined ? false : undefined,
        });
        continue;
      }

      if (isShortOptionGroup(arg, options)) {
        var expanded = [];
        for (var g = 1; g < arg.length; g++) {
          ArrayPrototypePush(expanded, '-' + StringPrototypeCharAt(arg, g));
        }
        for (var e = expanded.length - 1; e >= 0; e--) {
          ArrayPrototypeUnshift(remaining, expanded[e]);
        }
        groupCount = expanded.length;
        continue;
      }

      if (isShortOptionAndValue(arg, options)) {
        var shortChar = StringPrototypeCharAt(arg, 1);
        ArrayPrototypePush(tokens, {
          kind: 'option',
          name: findLongOptionForShort(shortChar, options),
          rawName: '-' + shortChar,
          index: index,
          value: StringPrototypeSlice(arg, 2),
          inlineValue: true,
        });
        continue;
      }

      if (isLoneLongOption(arg)) {
        var lName = StringPrototypeSlice(arg, 2);
        var lOpt = objectGetOwn(options, lName);
        var lValue;
        if (lOpt !== undefined && lOpt.type === 'string' && nextArg !== undefined) {
          lValue = ArrayPrototypeShift(remaining);
        }
        ArrayPrototypePush(tokens, {
          kind: 'option',
          name: lName,
          rawName: arg,
          index: index,
          value: lValue,
          inlineValue: lValue !== undefined ? false : undefined,
        });
        continue;
      }

      if (isLongOptionAndValue(arg)) {
        var eq = StringPrototypeIndexOf(arg, '=');
        var lvName = StringPrototypeSlice(arg, 2, eq);
        ArrayPrototypePush(tokens, {
          kind: 'option',
          name: lvName,
          rawName: '--' + lvName,
          index: index,
          value: StringPrototypeSlice(arg, eq + 1),
          inlineValue: true,
        });
        continue;
      }

      ArrayPrototypePush(tokens, { kind: 'positional', index: index, value: arg });
    }
    return tokens;
  }

  function checkOptionUsage(token, options) {
    if (!ObjectPrototypeHasOwnProperty(options, token.name)) {
      throw codedError('ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '" + token.rawName + "'");
    }
    var spec = options[token.name];
    if (spec.type === 'string' && typeof token.value !== 'string') {
      throw codedError(
        'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        "Option '" + token.rawName + " <value>' argument missing",
      );
    }
    if (spec.type === 'boolean' && token.value !== undefined) {
      throw codedError(
        'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        "Option '" + token.rawName + "' does not take an argument",
      );
    }
  }

  function checkOptionLikeValue(token) {
    if (!token.inlineValue && isOptionLikeValue(token.value)) {
      throw codedError(
        'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        "Option '" +
          token.rawName +
          "' argument is ambiguous.\nDid you forget to specify the option argument for '" +
          token.rawName +
          "'?",
      );
    }
  }

  function storeOption(name, value, options, values) {
    var spec = objectGetOwn(options, name);
    var v = spec !== undefined && spec.type === 'string' ? value : true;
    if (spec !== undefined && spec.multiple) {
      if (ObjectPrototypeHasOwnProperty(values, name)) ArrayPrototypePush(values[name], v);
      else values[name] = [v];
    } else {
      values[name] = v;
    }
  }

  function parseArgs(config) {
    config = config || {};
    var args =
      objectGetOwn(config, 'args') !== undefined
        ? config.args
        : ArrayPrototypeSlice(process.argv, 2);
    var strict = objectGetOwn(config, 'strict');
    if (strict === undefined) strict = true;
    var allowPositionals = objectGetOwn(config, 'allowPositionals');
    if (allowPositionals === undefined) allowPositionals = !strict;
    var allowNegative = objectGetOwn(config, 'allowNegative') === true;
    var returnTokens = objectGetOwn(config, 'tokens') === true;
    var options = objectGetOwn(config, 'options') || {};

    if (typeof options !== 'object' || options === null) {
      throw codedError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
    }

    var tokens = argsToTokens(args, options, allowNegative);

    var result = { values: { __proto__: null }, positionals: [] };
    if (returnTokens) result.tokens = tokens;

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (token.kind === 'option') {
        if (strict) {
          checkOptionUsage(token, options);
          checkOptionLikeValue(token);
        }
        storeOption(token.name, token.value, options, result.values);
      } else if (token.kind === 'positional') {
        if (!allowPositionals) {
          throw codedError(
            'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
            "Unexpected argument '" +
              token.value +
              "'. This command does not take positional arguments",
          );
        }
        ArrayPrototypePush(result.positionals, token.value);
      }
    }

    // Apply defaults for options never seen.
    var optionKeys = ObjectKeys(options);
    for (var k = 0; k < optionKeys.length; k++) {
      var name = optionKeys[k];
      if (
        options[name].default !== undefined &&
        !ObjectPrototypeHasOwnProperty(result.values, name)
      ) {
        result.values[name] = options[name].default;
      }
    }

    return result;
  }

  module.exports = { parseArgs: parseArgs };
});
