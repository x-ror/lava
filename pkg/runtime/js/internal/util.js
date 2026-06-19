// node:util — the subset Lava needs today: inspect() for readable value
// rendering, and format()/formatWithOptions() for printf-style substitution.
// Pure JS, no native dependencies. Ported in spirit from Node's
// lib/internal/util/inspect.js but trimmed to the common cases.
(function (require, module) {
  'use strict';

  var customInspect =
    typeof Symbol !== 'undefined' && Symbol.for ? Symbol.for('nodejs.util.inspect.custom') : null;

  function quote(s) {
    return "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n') + "'";
  }

  function inspect(v, opts, seen, depth) {
    opts = opts || {};
    seen = seen || [];
    depth = depth || 0;
    var maxDepth = opts.depth === undefined ? 2 : opts.depth === null ? Infinity : opts.depth;

    var t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return depth === 0 ? v : quote(v);
    if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
    if (t === 'boolean') return String(v);
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') {
      var fn = v.name;
      return fn ? '[Function: ' + fn + ']' : '[Function (anonymous)]';
    }
    // Honor the util.inspect custom hook (Buffer renders as "<Buffer ..>"). Node
    // passes (depth, options, inspect) and formats whatever the hook returns:
    // a string is used verbatim, anything else (number, object, …) is inspected
    // in its place, and returning the object itself falls through to default
    // formatting.
    if (customInspect && typeof v[customInspect] === 'function') {
      var nested = seen.concat([v]);
      var recurse = function (val, o) {
        return inspect(val, o || opts, nested, depth + 1);
      };
      var custom = v[customInspect](depth, opts, recurse);
      if (custom !== v) {
        return typeof custom === 'string' ? custom : inspect(custom, opts, nested, depth);
      }
    }
    if (seen.indexOf(v) !== -1) return '[Circular *1]';
    if (v instanceof Error) return v.stack ? v.stack : v.name + ': ' + v.message;
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return v.toString();
    if (depth > maxDepth) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen = seen.concat([v]);

    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(inspect(v[i], opts, seen, depth + 1));
      return '[ ' + arr.join(', ') + ' ]';
    }
    if (typeof Map !== 'undefined' && v instanceof Map) {
      var mp = [];
      v.forEach(function (val, key) {
        mp.push(inspect(key, opts, seen, depth + 1) + ' => ' + inspect(val, opts, seen, depth + 1));
      });
      return 'Map(' + v.size + ') {' + (mp.length > 0 ? ' ' + mp.join(', ') + ' ' : '') + '}';
    }
    if (typeof Set !== 'undefined' && v instanceof Set) {
      var st = [];
      v.forEach(function (val) {
        st.push(inspect(val, opts, seen, depth + 1));
      });
      return 'Set(' + v.size + ') {' + (st.length > 0 ? ' ' + st.join(', ') + ' ' : '') + '}';
    }

    var keys = Object.keys(v);
    var ctor = v.constructor && v.constructor.name;
    var prefix = ctor && ctor !== 'Object' ? ctor + ' ' : '';
    if (keys.length === 0) return prefix + '{}';
    var props = [];
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : quote(key);
      props.push(name + ': ' + inspect(v[key], opts, seen, depth + 1));
    }
    return prefix + '{ ' + props.join(', ') + ' }';
  }

  function stringify(v) {
    return typeof v === 'string' ? v : inspect(v, {}, [], 1);
  }

  function formatWithOptions(opts, _f) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length === 0) return '';
    var first = args[0];
    var i = 1;
    var result;
    if (typeof first === 'string' && first.indexOf('%') !== -1) {
      result = '';
      for (var p = 0; p < first.length; p++) {
        var ch = first.charAt(p);
        if (ch === '%' && p + 1 < first.length) {
          var spec = first.charAt(p + 1);
          if (spec === '%') {
            result += '%';
            p++;
            continue;
          }
          if ('sdifjoOc'.indexOf(spec) !== -1) {
            if (i >= args.length) {
              result += '%' + spec;
              p++;
              continue;
            }
            var a = args[i++];
            p++;
            if (spec === 's') result += typeof a === 'string' ? a : stringify(a);
            else if (spec === 'd' || spec === 'i')
              result +=
                typeof a === 'bigint'
                  ? String(a) + 'n'
                  : typeof a === 'symbol'
                    ? 'NaN'
                    : String(Math.trunc(Number(a)));
            else if (spec === 'f') result += typeof a === 'symbol' ? 'NaN' : String(parseFloat(a));
            else if (spec === 'j') {
              try {
                result += JSON.stringify(a);
              } catch {
                result += '[Circular]';
              }
            } else if (spec === 'o' || spec === 'O') result += inspect(a, opts, [], 1);
            /* spec === "c": CSS directive, consumed and ignored */
            continue;
          }
        }
        result += ch;
      }
    } else {
      result = stringify(first);
    }
    for (; i < args.length; i++) result += ' ' + stringify(args[i]);
    return result;
  }

  function format(_f) {
    return formatWithOptions.apply(null, [{}].concat(Array.prototype.slice.call(arguments)));
  }

  // util.promisify — wrap a (…args, callback(err, value)) function as one returning a
  // Promise. Honors the util.promisify.custom symbol and copies the original's own
  // properties / prototype, matching Node (the multi-arg `customArgs` form is omitted).
  var kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');

  function promisify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    if (original[kCustomPromisify]) {
      var custom = original[kCustomPromisify];
      if (typeof custom !== 'function') {
        throw new TypeError('The "util.promisify.custom" property must be of type function');
      }
      return custom;
    }
    function fn() {
      var args = Array.prototype.slice.call(arguments);
      var self = this;
      return new Promise(function (resolve, reject) {
        args.push(function (err, value) {
          if (err) reject(err);
          else resolve(value);
        });
        Reflect.apply(original, self, args);
      });
    }
    Object.setPrototypeOf(fn, Object.getPrototypeOf(original));
    Object.defineProperty(fn, kCustomPromisify, {
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return Object.defineProperties(fn, Object.getOwnPropertyDescriptors(original));
  }
  promisify.custom = kCustomPromisify;

  // util.callbackify — the inverse: wrap an async/Promise-returning function as one
  // taking a Node-style (err, value) callback. Rejections are delivered on a fresh tick;
  // a falsy rejection reason is wrapped like Node.
  function callbackify(original) {
    if (typeof original !== 'function') {
      throw new TypeError('The "original" argument must be of type function');
    }
    function callbackified() {
      var args = Array.prototype.slice.call(arguments);
      var cb = args.pop();
      if (typeof cb !== 'function') {
        throw new TypeError('The last argument must be of type function');
      }
      var self = this;
      Promise.resolve(Reflect.apply(original, self, args)).then(
        function (ret) {
          process.nextTick(cb.bind(self, null, ret));
        },
        function (rej) {
          var reason = rej;
          if (!reason) {
            reason = new Error('Promise was rejected with a falsy value');
            reason.reason = rej;
          }
          process.nextTick(cb.bind(self, reason));
        },
      );
    }
    Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
    Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original));
    return callbackified;
  }

  // util.inherits — set up classic prototypal inheritance and the `super_` back-link.
  function inherits(ctor, superCtor) {
    if (ctor == null || typeof ctor !== 'function') {
      throw new TypeError('The "ctor" argument must be of type function');
    }
    if (superCtor == null || typeof superCtor !== 'function') {
      throw new TypeError('The "superCtor" argument must be of type function');
    }
    if (superCtor.prototype === undefined) {
      throw new TypeError('The "superCtor.prototype" property must be of type object');
    }
    Object.defineProperty(ctor, 'super_', {
      value: superCtor,
      writable: true,
      configurable: true,
    });
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }

  // util.deprecate — return a wrapper that emits a one-time deprecation warning, then
  // delegates to fn. Suppressed entirely when process.noDeprecation is set.
  function deprecate(fn, msg, code) {
    if (process.noDeprecation === true) return fn;
    var warned = false;
    function deprecated() {
      if (!warned) {
        warned = true;
        if (typeof process.emitWarning === 'function') {
          process.emitWarning(msg, 'DeprecationWarning', code);
        } else {
          console.error('DeprecationWarning: ' + msg);
        }
      }
      return Reflect.apply(fn, this, arguments);
    }
    return deprecated;
  }

  // util.isDeepStrictEqual — structural strict equality, matching Node's algorithm:
  // SameValue-ish primitives (NaN equal, +0 !== -0), matching prototype + [[Class]] tag,
  // special handling for Date/RegExp/Error/boxed primitives/Map/Set/ArrayBuffer/TypedArray/
  // DataView, recursive comparison of own enumerable string + symbol keys, and circular refs.
  var objTag = function (v) {
    return Object.prototype.toString.call(v);
  };

  function bytesEqual(x, y) {
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function ownEnumerableKeys(o) {
    var keys = Object.keys(o);
    var syms = Object.getOwnPropertySymbols(o);
    for (var i = 0; i < syms.length; i++) {
      if (Object.prototype.propertyIsEnumerable.call(o, syms[i])) keys.push(syms[i]);
    }
    return keys;
  }

  function keysEqual(a, b, aStack, bStack) {
    var aKeys = ownEnumerableKeys(a);
    if (aKeys.length !== ownEnumerableKeys(b).length) return false;
    for (var i = 0; i < aKeys.length; i++) {
      var k = aKeys[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepStrict(a[k], b[k], aStack, bStack)) return false;
    }
    return true;
  }

  function collectionEqual(aEntries, bEntries, withValue, aStack, bStack) {
    var used = new Array(bEntries.length);
    for (var i = 0; i < aEntries.length; i++) {
      var found = false;
      for (var j = 0; j < bEntries.length; j++) {
        if (used[j]) continue;
        var keyOk = deepStrict(aEntries[i][0], bEntries[j][0], aStack, bStack);
        var valOk = !withValue || deepStrict(aEntries[i][1], bEntries[j][1], aStack, bStack);
        if (keyOk && valOk) {
          used[j] = true;
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  function deepStrict(a, b, aStack, bStack) {
    if (a === b) return a !== 0 || Object.is(a, b); // +0 !== -0; everything else equal
    if (typeof a !== 'object' || a === null) {
      // primitive (or null) — equal only if both are NaN
      return typeof a === 'number' && a !== a && typeof b === 'number' && b !== b;
    }
    if (typeof b !== 'object' || b === null) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

    var tag = objTag(a);
    if (tag !== objTag(b)) return false;

    switch (tag) {
      case '[object Number]':
      case '[object Boolean]':
      case '[object String]':
      case '[object BigInt]':
      case '[object Symbol]': {
        var av = a.valueOf();
        var bv = b.valueOf();
        if (av === bv) return av !== 0 || Object.is(av, bv);
        return typeof av === 'number' && av !== av && bv !== bv;
      }
      case '[object Date]':
        return Object.is(a.getTime(), b.getTime());
      case '[object RegExp]':
        if (a.source !== b.source || a.flags !== b.flags) return false;
        break;
      case '[object Error]':
        if (a.name !== b.name || a.message !== b.message) return false;
        break;
      case '[object ArrayBuffer]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(new Uint8Array(a), new Uint8Array(b));
      case '[object DataView]':
        if (a.byteLength !== b.byteLength) return false;
        return bytesEqual(
          new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
          new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
        );
    }

    // Typed arrays: element-wise (NaN-aware); then fall through to compare any extra keys.
    if (ArrayBuffer.isView(a) && tag !== '[object DataView]') {
      if (a.length !== b.length) return false;
      for (var t = 0; t < a.length; t++) {
        if (!(a[t] === b[t] || (a[t] !== a[t] && b[t] !== b[t]))) return false;
      }
    }

    // Circular-reference guard.
    for (var s = 0; s < aStack.length; s++) {
      if (aStack[s] === a) return bStack[s] === b;
    }
    aStack.push(a);
    bStack.push(b);

    var result;
    if (tag === '[object Map]') {
      if (a.size !== b.size) {
        result = false;
      } else {
        var aME = [];
        var bME = [];
        a.forEach(function (v, k) {
          aME.push([k, v]);
        });
        b.forEach(function (v, k) {
          bME.push([k, v]);
        });
        result = collectionEqual(aME, bME, true, aStack, bStack);
      }
    } else if (tag === '[object Set]') {
      if (a.size !== b.size) {
        result = false;
      } else {
        var aSE = [];
        var bSE = [];
        a.forEach(function (v) {
          aSE.push([v]);
        });
        b.forEach(function (v) {
          bSE.push([v]);
        });
        result = collectionEqual(aSE, bSE, false, aStack, bStack);
      }
    } else {
      result = keysEqual(a, b, aStack, bStack);
    }

    aStack.pop();
    bStack.pop();
    return result;
  }

  function isDeepStrictEqual(a, b) {
    return deepStrict(a, b, [], []);
  }

  // util.styleText — wrap text in ANSI SGR codes. `format` is a style name or an array
  // of them (opens applied in order, closes in reverse). Mirrors Node's util.inspect.colors
  // table. By default the styling is suppressed when the target stream is not a TTY
  // (options.validateStream, default true; options.stream, default process.stdout) — pass
  // { validateStream: false } to force it. Null-prototype table so a key like 'constructor'
  // can't resolve to an inherited value.
  var styleTextColors = {
    __proto__: null,
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, 39],
    grey: [90, 39],
    redBright: [91, 39],
    greenBright: [92, 39],
    yellowBright: [93, 39],
    blueBright: [94, 39],
    magentaBright: [95, 39],
    cyanBright: [96, 39],
    whiteBright: [97, 39],
    bgGray: [100, 49],
    bgGrey: [100, 49],
    bgRedBright: [101, 49],
    bgGreenBright: [102, 49],
    bgYellowBright: [103, 49],
    bgBlueBright: [104, 49],
    bgMagentaBright: [105, 49],
    bgCyanBright: [106, 49],
    bgWhiteBright: [107, 49],
  };

  function styleTextError(code, message) {
    var e = code === 'ERR_INVALID_ARG_TYPE' ? new TypeError(message) : new RangeError(message);
    e.code = code;
    return e;
  }

  function styleText(format, text, options) {
    if (typeof text !== 'string') {
      throw styleTextError(
        'ERR_INVALID_ARG_TYPE',
        'The "text" argument must be of type string. Received ' + typeof text,
      );
    }
    var formats = Array.isArray(format) ? format : [format];
    var open = '';
    var close = '';
    for (var i = 0; i < formats.length; i++) {
      var f = formats[i];
      if (f === 'none') continue;
      var codes = typeof f === 'string' ? styleTextColors[f] : undefined;
      if (codes === undefined) {
        throw styleTextError(
          'ERR_INVALID_ARG_VALUE',
          "The argument 'format' must be a valid style. Received " + inspect(f, {}, [], 1),
        );
      }
      open += '\x1b[' + codes[0] + 'm';
      close = '\x1b[' + codes[1] + 'm' + close; // closes unwind in reverse
    }

    options = options || {};
    if (options.validateStream !== false) {
      var stream =
        options.stream !== undefined
          ? options.stream
          : typeof process !== 'undefined'
            ? process.stdout
            : undefined;
      if (!stream || !stream.isTTY) return text;
    }
    return open + text + close;
  }

  module.exports = {
    inspect: function (v, opts) {
      return inspect(v, opts, [], 0);
    },
    format: format,
    formatWithOptions: formatWithOptions,
    promisify: promisify,
    callbackify: callbackify,
    inherits: inherits,
    deprecate: deprecate,
    isDeepStrictEqual: isDeepStrictEqual,
    parseArgs: require('parse_args').parseArgs,
    styleText: styleText,
    // Node exposes the same object via require('node:util').types and
    // require('node:util/types'); many packages use the former.
    types: require('util/types'),
  };
});
