// Primordials — pristine references to the JS intrinsics the internal modules
// rely on, captured once at startup *before any user code runs* (the loader
// eager-requires this module first; see loader.js). Internal modules consume it
// via `require('primordials')` so their behavior cannot be altered by a script
// that mutates a shared prototype (Array.prototype.push = …) or replaces a global
// (globalThis.Object = …). This mirrors Node's lib/internal/primordials in spirit:
// captured statics plus *uncurried* prototype methods.
//
// `uncurryThis(fn)(thisArg, ...args)` === `fn.call(thisArg, ...args)`, but bound to
// the original `fn` so a later reassignment of e.g. Array.prototype.push cannot
// reach it. So `ArrayPrototypePush(arr, x)` is the pollution-proof `arr.push(x)`.
(function (require, module) {
  'use strict';

  var FunctionPrototype = Function.prototype;
  var bind = FunctionPrototype.bind;
  var call = FunctionPrototype.call;
  var apply = FunctionPrototype.apply;
  // The classic uncurryThis: bind.bind(call) yields f => call.bind(f), and
  // call.bind(f)(thisArg, ...args) === f.call(thisArg, ...args).
  var uncurryThis = bind.bind(call);

  var ObjectProto = Object.prototype;
  var ArrayProto = Array.prototype;
  var StringProto = String.prototype;

  module.exports = {
    uncurryThis: uncurryThis,

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

    // --- Object.prototype.* (uncurried: call as fn(obj, ...)) ---
    ObjectPrototypeHasOwnProperty: uncurryThis(ObjectProto.hasOwnProperty),
    ObjectPrototypeToString: uncurryThis(ObjectProto.toString),

    // --- Function.prototype.* ---
    FunctionPrototypeApply: uncurryThis(apply),
    FunctionPrototypeCall: uncurryThis(call),
    FunctionPrototypeBind: uncurryThis(bind),

    // --- Array.prototype.* (uncurried: ArrayPrototypePush(arr, x)) ---
    ArrayPrototypePush: uncurryThis(ArrayProto.push),
    ArrayPrototypePop: uncurryThis(ArrayProto.pop),
    ArrayPrototypeShift: uncurryThis(ArrayProto.shift),
    ArrayPrototypeUnshift: uncurryThis(ArrayProto.unshift),
    ArrayPrototypeSlice: uncurryThis(ArrayProto.slice),
    ArrayPrototypeSplice: uncurryThis(ArrayProto.splice),
    ArrayPrototypeIndexOf: uncurryThis(ArrayProto.indexOf),
    ArrayPrototypeIncludes: uncurryThis(ArrayProto.includes),
    ArrayPrototypeForEach: uncurryThis(ArrayProto.forEach),
    ArrayPrototypeMap: uncurryThis(ArrayProto.map),
    ArrayPrototypeFilter: uncurryThis(ArrayProto.filter),
    ArrayPrototypeJoin: uncurryThis(ArrayProto.join),
    ArrayPrototypeConcat: uncurryThis(ArrayProto.concat),
    ArrayPrototypeReverse: uncurryThis(ArrayProto.reverse),
    ArrayPrototypeSort: uncurryThis(ArrayProto.sort),

    // --- String.prototype.* (uncurried: StringPrototypeSlice(str, ...)) ---
    StringPrototypeSlice: uncurryThis(StringProto.slice),
    StringPrototypeIndexOf: uncurryThis(StringProto.indexOf),
    StringPrototypeCharCodeAt: uncurryThis(StringProto.charCodeAt),
    Uint8ArrayPrototypeSet: uncurryThis(Uint8Array.prototype.set),
    StringPrototypeCharAt: uncurryThis(StringProto.charAt),
    StringPrototypeReplace: uncurryThis(StringProto.replace),
    StringPrototypeReplaceAll: uncurryThis(StringProto.replaceAll),
    StringPrototypeSplit: uncurryThis(StringProto.split),
    StringPrototypeToLowerCase: uncurryThis(StringProto.toLowerCase),
    StringPrototypeToUpperCase: uncurryThis(StringProto.toUpperCase),
    StringPrototypeTrim: uncurryThis(StringProto.trim),
    StringPrototypeStartsWith: uncurryThis(StringProto.startsWith),
    StringPrototypeEndsWith: uncurryThis(StringProto.endsWith),
  };

  // Freeze the table so a consumer (or a leak) cannot mutate the shared set.
  Object.freeze(module.exports);
});
