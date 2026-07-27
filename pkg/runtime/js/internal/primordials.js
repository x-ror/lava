// Primordials — pristine references to the JS intrinsics the internal modules
// rely on, captured once at startup *before any user code runs* (the loader
// eager-requires this module first; see loader.js). Internal modules consume it
// via `require('primordials')` so their behavior cannot be altered by a script
// that mutates a shared prototype (Array.prototype.push = …) or replaces a global
// (globalThis.Object = …). Mirrors Node's lib/internal/primordials in spirit:
// captured statics plus prototype methods callable as fn(thisArg, ...args).
//
// JSC COST MODEL (why this is not Node's uncurryThis). Node builds its
// uncurried methods with `bind.bind(call)`, which V8 inlines through the bound
// wrapper for free. JSC does NOT inline through a JSBoundFunction — measured
// ~28x vs a direct call for `charCodeAt` in a hot loop — so the classic
// uncurryThis is a hot-path tax here. JSC composes `.call` well instead
// (~1.3–2x), so every wrapper below is a fixed-arity closure over the captured
// method that invokes it via `.call`. Variadic methods (push/unshift/splice/
// concat) use a small arguments switch (~7x, but they are never in a per-char
// loop). The tightest-arity path keeps `P.StringPrototypeCharCodeAt(s, i)` at
// ~2x, so internal modules can route through primordials without a separate
// capture-and-.call dance for the common case.
//
// THREAT MODEL / RESIDUAL. The captured method makes these wrappers immune to
// prototype-method pollution (Array.prototype.push = …) and global replacement
// (globalThis.Array = …) — the realistic axes. They invoke through `.call`,
// which reads Function.prototype.call dynamically, so a script that overrides
// `Function.prototype.call/apply` can still reach them. That exotic axis (which
// also breaks essentially all JS that uses `.call`, so it is self-defeating as
// an attack) is closed only by lockIntrinsics(), applied opt-in by the runtime.
// The accessor axis (a setter on a numeric-index property of Array/Object.proto)
// is not a method concern and is handled per-hot-array with null prototypes in
// the consuming modules.
(function (require, module) {
  'use strict';

  var FunctionProto = Function.prototype;
  var call = FunctionProto.call;
  var apply = FunctionProto.apply;
  var bind = FunctionProto.bind;

  var ObjectProto = Object.prototype;
  var ArrayProto = Array.prototype;
  var StringProto = String.prototype;

  // Fixed-arity `.call` wrappers — the fast path on JSC. `fn` is the captured
  // pristine method; the closure forwards a known number of positional args.
  function caller0(fn) {
    return function (t) {
      return fn.call(t);
    };
  }
  function caller1(fn) {
    return function (t, a) {
      return fn.call(t, a);
    };
  }
  function caller2(fn) {
    return function (t, a, b) {
      return fn.call(t, a, b);
    };
  }
  function caller3(fn) {
    return function (t, a, b, c) {
      return fn.call(t, a, b, c);
    };
  }
  // Variadic fallback for genuinely variadic methods. The arguments switch costs
  // more than a fixed-arity closure on JSC, but push/unshift/splice/concat are
  // never in a per-character loop, so it does not matter in practice.
  function callerN(fn) {
    return function (t) {
      switch (arguments.length) {
        case 1:
          return fn.call(t);
        case 2:
          return fn.call(t, arguments[1]);
        case 3:
          return fn.call(t, arguments[1], arguments[2]);
        case 4:
          return fn.call(t, arguments[1], arguments[2], arguments[3]);
        default: {
          // >3 args: hand off to the captured apply with a copied args tail.
          var n = arguments.length - 1;
          var rest = [];
          for (var i = 0; i < n; i++) rest[i] = arguments[i + 1];
          return apply.call(fn, t, rest);
        }
      }
    };
  }

  // uncurryThis keeps its name and variadic contract for any external caller and
  // for parity with Node's export, but is now `.call`-based (not bind.bind(call)).
  var uncurryThis = callerN;

  // lockIntrinsics pins Function.prototype.call/apply/bind so the wrappers'
  // `.call` route cannot be poisoned. Opt-in: the runtime applies it only under
  // the frozen-intrinsics flag (npm packages that legitimately reassign these
  // are vanishingly rare but not proven absent). Idempotent; safe to call once
  // at bootstrap, before user code. Locking keeps the methods callable — it only
  // forbids reassignment.
  function lockIntrinsics() {
    var def = Object.defineProperty;
    var lock = function (obj, name, value) {
      try {
        def(obj, name, { value: value, writable: false, configurable: false });
      } catch (e) {
        /* already locked / non-configurable — leave as is */
      }
    };
    lock(FunctionProto, 'call', call);
    lock(FunctionProto, 'apply', apply);
    lock(FunctionProto, 'bind', bind);
  }

  module.exports = {
    uncurryThis: uncurryThis,
    lockIntrinsics: lockIntrinsics,

    // --- Constructors / namespaces (captured so a replaced global is ignored) ---
    Object: Object,
    Array: Array,
    Promise: Promise,
    Map: Map,
    Set: Set,
    WeakMap: WeakMap,
    Symbol: Symbol,
    Reflect: Reflect,
    JSON: JSON,
    Math: Math,
    Number: Number,
    RegExp: RegExp,
    Error: Error,
    TypeError: TypeError,
    RangeError: RangeError,
    Uint8Array: Uint8Array,

    // --- Object statics ---
    ObjectCreate: Object.create,
    ObjectKeys: Object.keys,
    ObjectValues: Object.values,
    ObjectEntries: Object.entries,
    ObjectAssign: Object.assign,
    ObjectFreeze: Object.freeze,
    ObjectIs: Object.is,
    ObjectDefineProperty: Object.defineProperty,
    ObjectDefineProperties: Object.defineProperties,
    ObjectGetPrototypeOf: Object.getPrototypeOf,
    ObjectSetPrototypeOf: Object.setPrototypeOf,
    ObjectGetOwnPropertyNames: Object.getOwnPropertyNames,
    ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    ObjectGetOwnPropertyDescriptors: Object.getOwnPropertyDescriptors,
    ObjectGetOwnPropertySymbols: Object.getOwnPropertySymbols,

    // --- Array / Reflect / JSON / Math / Number statics ---
    ArrayIsArray: Array.isArray,
    ArrayFrom: Array.from,
    ArrayOf: Array.of,
    ReflectApply: Reflect.apply,
    ReflectOwnKeys: Reflect.ownKeys,
    ReflectGetPrototypeOf: Reflect.getPrototypeOf,
    JSONStringify: JSON.stringify,
    JSONParse: JSON.parse,
    MathTrunc: Math.trunc,
    MathMax: Math.max,
    MathMin: Math.min,
    MathFloor: Math.floor,
    NumberIsInteger: Number.isInteger,
    NumberIsFinite: Number.isFinite,
    NumberIsNaN: Number.isNaN,

    // --- Object.prototype.* (call as fn(obj, ...)) ---
    ObjectPrototypeHasOwnProperty: caller1(ObjectProto.hasOwnProperty),
    ObjectPrototypeToString: caller0(ObjectProto.toString),

    // --- Function.prototype.* ---
    FunctionPrototypeApply: caller2(apply),
    FunctionPrototypeCall: callerN(call),
    FunctionPrototypeBind: callerN(bind),

    // --- Array.prototype.* (ArrayPrototypePush(arr, x)) ---
    ArrayPrototypePush: callerN(ArrayProto.push),
    ArrayPrototypePop: caller0(ArrayProto.pop),
    ArrayPrototypeShift: caller0(ArrayProto.shift),
    ArrayPrototypeUnshift: callerN(ArrayProto.unshift),
    ArrayPrototypeSlice: caller2(ArrayProto.slice),
    ArrayPrototypeSplice: callerN(ArrayProto.splice),
    ArrayPrototypeIndexOf: caller2(ArrayProto.indexOf),
    ArrayPrototypeIncludes: caller2(ArrayProto.includes),
    ArrayPrototypeForEach: caller2(ArrayProto.forEach),
    ArrayPrototypeMap: caller2(ArrayProto.map),
    ArrayPrototypeFilter: caller2(ArrayProto.filter),
    ArrayPrototypeJoin: caller1(ArrayProto.join),
    ArrayPrototypeConcat: callerN(ArrayProto.concat),
    ArrayPrototypeReverse: caller0(ArrayProto.reverse),
    ArrayPrototypeSort: caller1(ArrayProto.sort),

    // --- String.prototype.* (StringPrototypeSlice(str, ...)) ---
    StringPrototypeSlice: caller2(StringProto.slice),
    StringPrototypeIndexOf: caller2(StringProto.indexOf),
    StringPrototypeCharCodeAt: caller1(StringProto.charCodeAt),
    StringPrototypeCharAt: caller1(StringProto.charAt),
    StringPrototypeCodePointAt: caller1(StringProto.codePointAt),
    StringPrototypeReplace: caller2(StringProto.replace),
    StringPrototypeReplaceAll: caller2(StringProto.replaceAll),
    StringPrototypeSplit: caller2(StringProto.split),
    StringPrototypeToLowerCase: caller0(StringProto.toLowerCase),
    StringPrototypeToUpperCase: caller0(StringProto.toUpperCase),
    StringPrototypeTrim: caller0(StringProto.trim),
    StringPrototypeStartsWith: caller2(StringProto.startsWith),
    StringPrototypeEndsWith: caller2(StringProto.endsWith),
    StringPrototypeNormalize: caller1(StringProto.normalize),
    StringPrototypeSubstr: caller2(StringProto.substr),
    StringPrototypePadStart: caller2(StringProto.padStart),

    Uint8ArrayPrototypeSet: caller2(Uint8Array.prototype.set),
  };

  // Freeze the table so a consumer (or a leak) cannot mutate the shared set.
  Object.freeze(module.exports);
});
