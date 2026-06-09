const assert = require('node:assert/strict');

// Exposed as a global.
assert.equal(typeof structuredClone, 'function');
assert.equal(globalThis.structuredClone, structuredClone);

// Primitives pass through.
assert.equal(structuredClone(42), 42);
assert.equal(structuredClone('hi'), 'hi');
assert.equal(structuredClone(true), true);
assert.equal(structuredClone(null), null);
assert.equal(structuredClone(undefined), undefined);
assert.equal(structuredClone(10n), 10n);

// Deep object clone produces a distinct graph.
const src = { a: 1, nested: { b: [1, 2, 3] } };
const out = structuredClone(src);
assert.deepEqual(out, src);
assert.notEqual(out, src);
assert.notEqual(out.nested, src.nested);
out.nested.b[0] = 99;
assert.equal(src.nested.b[0], 1);

// Arrays keep extra own-enumerable properties; holes are preserved.
const arr = [1, 2];
arr.foo = 'bar';
const carr = structuredClone(arr);
assert.deepEqual(carr, arr);
assert.equal(carr.foo, 'bar');
const holed = [1, , 3];
const choled = structuredClone(holed);
assert.equal(1 in choled, false);
assert.equal(choled.length, 3);

// Prototype, symbol keys, non-enumerable props, and getters are dropped/flattened.
class Point {
  constructor(x) {
    this.x = x;
  }
  mag() {
    return this.x;
  }
}
const cp = structuredClone(new Point(5));
assert.equal(cp instanceof Point, false);
assert.equal(Object.getPrototypeOf(cp), Object.prototype);
assert.equal(cp.x, 5);

const sym = Symbol('s');
const withSym = { keep: 1, [sym]: 2 };
const csym = structuredClone(withSym);
assert.equal(csym.keep, 1);
assert.equal(Object.getOwnPropertySymbols(csym).length, 0);

const hidden = {};
Object.defineProperty(hidden, 'h', { value: 7, enumerable: false });
assert.equal(Object.keys(structuredClone(hidden)).length, 0);

const getterObj = {
  get g() {
    return 42;
  },
};
const cgetter = structuredClone(getterObj);
assert.equal(cgetter.g, 42);
assert.equal(Object.getOwnPropertyDescriptor(cgetter, 'g').get, undefined);

// Date and RegExp.
const date = new Date(1717689600000);
const cdate = structuredClone(date);
assert.equal(cdate instanceof Date, true);
assert.equal(cdate.getTime(), date.getTime());
assert.notEqual(cdate, date);
const sharedDate = structuredClone({ a: date, b: date });
assert.equal(sharedDate.a, sharedDate.b);

const re = /ab+/gi;
re.lastIndex = 2;
const cre = structuredClone(re);
assert.equal(cre.source, 'ab+');
assert.equal(cre.flags, 'gi');
assert.equal(cre.lastIndex, 0);
const sharedRegExp = structuredClone({ a: re, b: re });
assert.equal(sharedRegExp.a, sharedRegExp.b);

// Map and Set, deep-cloning entries.
const map = new Map([['k', { n: 1 }]]);
const cmap = structuredClone(map);
assert.equal(cmap instanceof Map, true);
assert.deepEqual(cmap.get('k'), { n: 1 });
assert.notEqual(cmap.get('k'), map.get('k'));

const set = new Set([1, 2, 3]);
const cset = structuredClone(set);
assert.equal(cset instanceof Set, true);
assert.deepEqual([...cset], [1, 2, 3]);

// ArrayBuffer, typed arrays, and DataView; views over one buffer keep sharing it.
const ab = new Uint8Array([1, 2, 3, 4]).buffer;
const cab = structuredClone(ab);
assert.equal(cab instanceof ArrayBuffer, true);
assert.equal(cab.byteLength, 4);
assert.notEqual(cab, ab);

const buf = new ArrayBuffer(8);
new Uint8Array(buf)[0] = 1;
const shared = structuredClone({ u8: new Uint8Array(buf), u16: new Uint16Array(buf) });
shared.u8[0] = 9;
assert.equal(shared.u16[0], 9);

const dv = new DataView(new ArrayBuffer(4));
dv.setInt32(0, 123456);
const cdv = structuredClone(dv);
assert.equal(cdv instanceof DataView, true);
assert.equal(cdv.getInt32(0), 123456);

// Errors clone their type, message, stack, and cause.
const err = new TypeError('boom', { cause: new RangeError('why') });
const cerr = structuredClone(err);
assert.equal(cerr instanceof TypeError, true);
assert.equal(cerr.name, 'TypeError');
assert.equal(cerr.message, 'boom');
assert.equal(typeof cerr.stack, 'string');
assert.equal(cerr.cause instanceof RangeError, true);
assert.equal(cerr.cause.message, 'why');

// Cyclic references are preserved.
const cyclic = { name: 'root' };
cyclic.self = cyclic;
const ccyclic = structuredClone(cyclic);
assert.equal(ccyclic.self, ccyclic);
assert.equal(ccyclic.name, 'root');

// Non-cloneable inputs throw a DataCloneError.
for (const bad of [() => {}, Symbol('x'), Promise.resolve(1), new WeakMap(), new WeakSet()]) {
  assert.throws(
    () => structuredClone(bad),
    (e) => e.name === 'DataCloneError',
  );
}
assert.throws(() => structuredClone(), TypeError);

console.log('structured-clone-ok');
