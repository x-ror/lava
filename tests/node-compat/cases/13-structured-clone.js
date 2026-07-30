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

// --- every view type, by brand ---------------------------------------------
// The clone rebuilds views from a captured prototype->constructor table. A closed
// table means a type absent from it THROWS, which is how Float16Array — which
// this runtime ships and Node clones — regressed while the suite stayed green
// because it only exercised Uint8Array/Uint16Array/DataView. Looping means the
// next brand JSC gains is caught rather than discovered.
for (const name of [
  'Uint8Array',
  'Uint8ClampedArray',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
]) {
  const Ctor = globalThis[name];
  if (typeof Ctor !== 'function') continue; // version-dependent, skip quietly
  const src = /^Big/.test(name) ? new Ctor([1n, 2n]) : new Ctor([1, 2]);
  const copy = structuredClone(src);
  assert.equal(Object.prototype.toString.call(copy), '[object ' + name + ']');
  assert.equal(copy.length, 2);
  assert.notEqual(copy.buffer, src.buffer);
}

// Buffer is a Uint8Array subclass and the spec clones by brand, so the clone is a
// plain Uint8Array in both runtimes — and so is an arbitrary subclass.
{
  const b = structuredClone(Buffer.from('hi'));
  assert.equal(b.constructor.name, 'Uint8Array');
  assert.ok(b instanceof Uint8Array);
  class Mine extends Uint8Array {}
  const m = structuredClone(new Mine([7, 8]));
  assert.equal(m.constructor.name, 'Uint8Array');
  assert.deepEqual(Array.from(m), [7, 8]);
  // A pooled, offset view keeps its contents and not its neighbours'.
  const off = Buffer.from('abcdefgh').subarray(3);
  assert.equal(Buffer.from(structuredClone(off)).toString(), 'defgh');
}

// --- the clone must not be steerable by the value under clone ---------------
// Each of these was a reproduced vector: `value.constructor` invoked attacker
// code with the internals' freshly cloned ArrayBuffer; a forged
// `Symbol.toStringTag` made a legitimate clone throw; and an Error `name` reached
// Object.prototype through an un-nulled lookup table.
{
  const realCtor = Uint8Array.prototype.constructor;
  let attackerRan = false;
  Uint8Array.prototype.constructor = function () {
    attackerRan = true;
    return { evil: 1 };
  };
  let tag, vals;
  try {
    const c = structuredClone(new Uint8Array([1, 2, 3]));
    tag = Object.prototype.toString.call(c);
    vals = Array.from(c).join(',');
  } finally {
    Uint8Array.prototype.constructor = realCtor;
  }
  assert.equal(attackerRan, false);
  assert.equal(tag, '[object Uint8Array]');
  assert.equal(vals, '1,2,3');
}
{
  const u = new Uint8Array([4, 5]);
  Object.defineProperty(u, Symbol.toStringTag, { value: 'Bar', configurable: true });
  const c = structuredClone(u);
  assert.equal(c.constructor.name, 'Uint8Array');
  assert.deepEqual(Array.from(c), [4, 5]);
}
{
  class Foo extends Uint8Array {
    get [Symbol.toStringTag]() {
      return 'Foo';
    }
  }
  const c = structuredClone(new Foo([1, 2, 3]));
  assert.equal(c.constructor.name, 'Uint8Array');
  assert.deepEqual(Array.from(c), [1, 2, 3]);
}
// An unrecognized `name` normalizes to Error (Node's behaviour, verified); a
// recognized one is carried over. The interesting inputs are the ones that used to
// reach Object.prototype through the lookup table.
for (const name of ['toString', 'valueOf', 'constructor', '__proto__', 'NotAnError']) {
  const e = new Error('boom');
  e.name = name;
  const c = structuredClone(e);
  assert.ok(c instanceof Error, name + ' should clone to an Error');
  assert.equal(c.message, 'boom');
  assert.equal(c.name, 'Error');
}
for (const [name, Ctor] of [
  ['TypeError', TypeError],
  ['RangeError', RangeError],
  ['SyntaxError', SyntaxError],
]) {
  const e = new Ctor('boom');
  const c = structuredClone(e);
  assert.equal(c.name, name);
  assert.equal(c.constructor.name, name);
}

console.log('structured-clone-ok');
