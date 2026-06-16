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

  module.exports = {
    inspect: function (v, opts) {
      return inspect(v, opts, [], 0);
    },
    format: format,
    formatWithOptions: formatWithOptions,
  };
});
