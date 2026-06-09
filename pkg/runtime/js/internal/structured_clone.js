// structuredClone (HTML structured clone algorithm), installed as a global like
// Buffer. JavaScriptCore's classic C API does not expose a native structuredClone,
// so this is an original JS implementation covering the cloneable types Node
// supports: primitives, Date, RegExp, ArrayBuffer + views, DataView, Map, Set,
// Array, Error, boxed primitives, and plain/own-enumerable objects. Cyclic and
// shared references are preserved via a memory map. Non-cloneable inputs
// (functions, symbols, Promise/WeakMap/WeakSet, and the `transfer` option) throw
// a DataCloneError rather than being silently mishandled.
(function (require, module, exports) {
  'use strict';

  function dataCloneError(message) {
    // Node throws a DOMException named "DataCloneError"; Lava has no
    // DOMException, so we surface an Error carrying the same `.name`.
    var err = new Error(message);
    err.name = 'DataCloneError';
    return err;
  }

  var toString = Object.prototype.toString;

  var ERROR_CTORS = {
    Error: Error,
    EvalError: EvalError,
    RangeError: RangeError,
    ReferenceError: ReferenceError,
    SyntaxError: SyntaxError,
    TypeError: TypeError,
    URIError: URIError,
  };

  // Copy `src`'s own enumerable string-keyed properties onto `dst`, deep-cloning
  // each value. Symbol keys and non-enumerable / inherited properties are dropped,
  // and getters are read to a plain data value — matching structuredClone.
  function copyOwnEnumerable(src, dst, seen) {
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      dst[keys[i]] = clone(src[keys[i]], seen);
    }
  }

  function clone(value, seen) {
    if (value === null) return null;
    var t = typeof value;
    if (
      t === 'string' ||
      t === 'number' ||
      t === 'boolean' ||
      t === 'undefined' ||
      t === 'bigint'
    ) {
      return value;
    }
    if (t === 'symbol') throw dataCloneError('Symbol could not be cloned.');
    if (t === 'function') throw dataCloneError('Function could not be cloned.');

    if (seen.has(value)) return seen.get(value);

    var tag = toString.call(value);

    if (tag === '[object Promise]' || tag === '[object WeakMap]' || tag === '[object WeakSet]') {
      throw dataCloneError(tag.slice(8, -1) + ' could not be cloned.');
    }

    if (tag === '[object Date]') {
      var date = new Date(value.getTime());
      seen.set(value, date);
      return date;
    }
    // lastIndex is intentionally not carried (Node resets it to 0).
    if (tag === '[object RegExp]') {
      var re = new RegExp(value.source, value.flags);
      seen.set(value, re);
      return re;
    }

    if (tag === '[object ArrayBuffer]') {
      var bufCopy = value.slice(0);
      seen.set(value, bufCopy);
      return bufCopy;
    }

    // Typed arrays and DataView: clone the backing buffer through `seen` so
    // multiple views over one buffer keep sharing a single cloned buffer.
    if (ArrayBuffer.isView(value)) {
      var clonedBuffer = clone(value.buffer, seen);
      var view;
      if (tag === '[object DataView]') {
        view = new DataView(clonedBuffer, value.byteOffset, value.byteLength);
      } else {
        view = new value.constructor(clonedBuffer, value.byteOffset, value.length);
      }
      seen.set(value, view);
      return view;
    }

    if (tag === '[object Map]') {
      var map = new Map();
      seen.set(value, map);
      value.forEach(function (v, k) {
        map.set(clone(k, seen), clone(v, seen));
      });
      return map;
    }

    if (tag === '[object Set]') {
      var set = new Set();
      seen.set(value, set);
      value.forEach(function (v) {
        set.add(clone(v, seen));
      });
      return set;
    }

    if (value instanceof Error) {
      var Ctor = ERROR_CTORS[value.name] || Error;
      var errClone = new Ctor(value.message);
      seen.set(value, errClone);
      if (value.name !== errClone.name) errClone.name = value.name;
      errClone.stack = value.stack;
      if ('cause' in value) errClone.cause = clone(value.cause, seen);
      return errClone;
    }

    if (tag === '[object Boolean]' || tag === '[object Number]' || tag === '[object String]') {
      var boxed = Object(value.valueOf());
      seen.set(value, boxed);
      return boxed;
    }

    if (Array.isArray(value)) {
      var arr = new Array(value.length);
      seen.set(value, arr);
      copyOwnEnumerable(value, arr, seen);
      return arr;
    }

    // Plain objects and ordinary class instances clone to a fresh object with
    // %Object.prototype% (the original prototype is not preserved).
    var obj = {};
    seen.set(value, obj);
    copyOwnEnumerable(value, obj, seen);
    return obj;
  }

  function structuredClone(value, options) {
    if (arguments.length === 0) {
      throw new TypeError('structuredClone requires at least 1 argument');
    }
    if (options != null && options.transfer != null) {
      var transfer = options.transfer;
      var hasItems = typeof transfer.length === 'number' ? transfer.length > 0 : false;
      if (hasItems) {
        throw dataCloneError('structuredClone transfer is not supported.');
      }
    }
    return clone(value, new Map());
  }

  if (typeof globalThis.structuredClone === 'undefined') {
    globalThis.structuredClone = structuredClone;
  }

  module.exports = { structuredClone: structuredClone };
});
