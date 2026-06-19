// util.parseArgs — a faithful port of Node's lib/internal/util/parse_args. Tokenizes an
// argv array against an options config (short/long, =value, -abc groups, string vs
// boolean, multiple, defaults, -- terminator) and returns { values, positionals[, tokens] }.
// strict mode (default) validates unknown options and option/value mismatches with Node's
// error codes. Pure JS; backs require('node:util').parseArgs.
(function (require, module) {
  'use strict';

  function objectGetOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }

  function codedError(code, message) {
    var e = new TypeError(message);
    e.code = code;
    return e;
  }

  function findLongOptionForShort(shortOption, options) {
    var keys = Object.keys(options);
    for (var i = 0; i < keys.length; i++) {
      if (options[keys[i]].short === shortOption) return keys[i];
    }
    return shortOption;
  }

  function isOptionLikeValue(value) {
    return typeof value === 'string' && value.length > 1 && value.charCodeAt(0) === 45;
  }
  function isLoneShortOption(arg) {
    return arg.length === 2 && arg.charCodeAt(0) === 45 && arg.charCodeAt(1) !== 45;
  }
  function isLoneLongOption(arg) {
    return (
      arg.length > 2 &&
      arg.charCodeAt(0) === 45 &&
      arg.charCodeAt(1) === 45 &&
      arg.indexOf('=') === -1
    );
  }
  function isLongOptionAndValue(arg) {
    return (
      arg.length > 2 &&
      arg.charCodeAt(0) === 45 &&
      arg.charCodeAt(1) === 45 &&
      arg.indexOf('=') !== -1
    );
  }
  function isShortGroupHead(arg) {
    return arg.length > 2 && arg.charCodeAt(0) === 45 && arg.charCodeAt(1) !== 45;
  }
  function isShortOptionAndValue(arg, options) {
    if (!isShortGroupHead(arg)) return false;
    var longOption = findLongOptionForShort(arg.charAt(1), options);
    var opt = objectGetOwn(options, longOption);
    return opt !== undefined && opt.type === 'string';
  }
  function isShortOptionGroup(arg, options) {
    if (!isShortGroupHead(arg)) return false;
    // A group only if the first short option is NOT a string option (which would instead
    // consume the rest as its value, handled by isShortOptionAndValue).
    var longOption = findLongOptionForShort(arg.charAt(1), options);
    var opt = objectGetOwn(options, longOption);
    return opt === undefined || opt.type !== 'string';
  }

  function argsToTokens(args, options, allowNegative) {
    var tokens = [];
    var remaining = args.slice();
    var index = -1;
    var groupCount = 0;

    while (remaining.length > 0) {
      var arg = remaining.shift();
      var nextArg = remaining[0];
      if (groupCount > 0) {
        groupCount--;
      } else {
        index++;
      }

      // '--' terminates option parsing; the rest are positionals.
      if (arg === '--') {
        tokens.push({ kind: 'option-terminator', index: index });
        for (var r = 0; r < remaining.length; r++) {
          tokens.push({ kind: 'positional', index: index + 1 + r, value: remaining[r] });
        }
        break;
      }

      if (isLoneShortOption(arg)) {
        var sLong = findLongOptionForShort(arg.charAt(1), options);
        var sOpt = objectGetOwn(options, sLong);
        var sValue;
        var sInline = false;
        if (sOpt !== undefined && sOpt.type === 'string' && nextArg !== undefined) {
          sValue = remaining.shift();
        } else if (allowNegative && (sOpt === undefined || sOpt.type === 'boolean')) {
          sValue = undefined;
        }
        tokens.push({
          kind: 'option',
          name: sLong,
          rawName: arg,
          index: index,
          value: sValue,
          inlineValue: sValue !== undefined ? sInline : undefined,
        });
        continue;
      }

      if (isShortOptionGroup(arg, options)) {
        var expanded = [];
        for (var g = 1; g < arg.length; g++) expanded.push('-' + arg.charAt(g));
        for (var e = expanded.length - 1; e >= 0; e--) remaining.unshift(expanded[e]);
        groupCount = expanded.length;
        continue;
      }

      if (isShortOptionAndValue(arg, options)) {
        var svLong = findLongOptionForShort(arg.charAt(1), options);
        tokens.push({
          kind: 'option',
          name: svLong,
          rawName: '-' + arg.charAt(1),
          index: index,
          value: arg.slice(2),
          inlineValue: true,
        });
        continue;
      }

      if (isLoneLongOption(arg)) {
        var lName = arg.slice(2);
        var lOpt = objectGetOwn(options, lName);
        var lValue;
        if (lOpt !== undefined && lOpt.type === 'string' && nextArg !== undefined) {
          lValue = remaining.shift();
        }
        tokens.push({
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
        var eq = arg.indexOf('=');
        var lvName = arg.slice(2, eq);
        tokens.push({
          kind: 'option',
          name: lvName,
          rawName: '--' + lvName,
          index: index,
          value: arg.slice(eq + 1),
          inlineValue: true,
        });
        continue;
      }

      tokens.push({ kind: 'positional', index: index, value: arg });
    }
    return tokens;
  }

  function checkOptionUsage(token, options, allowNegative) {
    if (!Object.prototype.hasOwnProperty.call(options, token.name)) {
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
      if (Object.prototype.hasOwnProperty.call(values, name)) values[name].push(v);
      else values[name] = [v];
    } else {
      values[name] = v;
    }
  }

  function parseArgs(config) {
    config = config || {};
    var args = objectGetOwn(config, 'args') !== undefined ? config.args : process.argv.slice(2);
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
          checkOptionUsage(token, options, allowNegative);
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
        result.positionals.push(token.value);
      }
    }

    // Apply defaults for options never seen.
    var optionKeys = Object.keys(options);
    for (var k = 0; k < optionKeys.length; k++) {
      var name = optionKeys[k];
      if (
        options[name].default !== undefined &&
        !Object.prototype.hasOwnProperty.call(result.values, name)
      ) {
        result.values[name] = options[name].default;
      }
    }

    return result;
  }

  module.exports = { parseArgs: parseArgs };
});
