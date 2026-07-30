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
  const src = name.startsWith('Big') ? new Ctor([1n, 2n]) : new Ctor([1, 2]);
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

// The WINDOW accessors, DataView half. structuredClone copies the whole backing
// ArrayBuffer and then re-slices the copy, so the offset/length it reads decide
// what the clone exposes — poison them over a POOLED victim and the clone hands
// back a neighbouring Buffer's bytes out of the shared allocUnsafe pool.
//
// DataView's three accessors are separate properties from %TypedArray%'s, so
// capturing the typed-array trio does not cover this arm: it was still reading
// `value.buffer` / `value.byteOffset` / `value.byteLength` live. Reproduced
// against a real secret in the neighbouring pool slot — node clones 2 bytes,
// Lava cloned 64 including the token.
//
// The poison is lifted BEFORE the clone is inspected, or the readout would go
// through the poisoned getters too and both runtimes would look equally broken.
{
  const secret = Buffer.from('SECRET-TOKEN-DO-NOT-DISCLOSE-9876543210');
  const victim = Buffer.from('hi');
  const dv = new DataView(victim.buffer, victim.byteOffset, 2);
  const dvp = DataView.prototype;
  const saved = ['byteOffset', 'byteLength'].map((k) => [
    k,
    Object.getOwnPropertyDescriptor(dvp, k),
  ]);
  let clone, threw;
  try {
    Object.defineProperty(dvp, 'byteOffset', { configurable: true, get: () => 0 });
    Object.defineProperty(dvp, 'byteLength', { configurable: true, get: () => 64 });
    clone = structuredClone(dv);
  } catch (e) {
    threw = e;
  } finally {
    for (const [k, d] of saved) Object.defineProperty(dvp, k, d);
  }
  assert.equal(threw, undefined, 'cloning a DataView must not throw under a poisoned window');
  assert.equal(Object.prototype.toString.call(clone), '[object DataView]');
  // The length assertion is the one that catches the over-read; the byte check is
  // what proves the over-read was a disclosure and not just a longer zero run.
  // Carries a message so the mutation gate can record WHY this goes red — without
  // one the failure reads `64 strictEqual 2`, which names no vector.
  assert.equal(clone.byteLength, 2, 'DataView clone window must not widen under a poisoned getter');
  const bytes = Buffer.from(clone.buffer, clone.byteOffset, clone.byteLength).toString('latin1');
  assert.equal(bytes, 'hi');
  assert.equal(bytes.indexOf('SECRET'), -1, 'clone must not expose pool neighbours');
  // Keep the neighbour referenced so its pool slot cannot be recycled before the
  // clone above reads across it.
  assert.equal(secret.length, 39);
}

// The typed-array half of the same vector, for symmetry: these getters were
// already captured, so this arm guards against a regression that un-captures them.
{
  const secret = Buffer.from('SECRET-TOKEN-DO-NOT-DISCLOSE-9876543210');
  const victim = Buffer.from('hi');
  const taProto = Object.getPrototypeOf(Uint8Array.prototype);
  const saved = ['byteOffset', 'byteLength', 'length'].map((k) => [
    k,
    Object.getOwnPropertyDescriptor(taProto, k),
  ]);
  let clone, threw;
  try {
    Object.defineProperty(taProto, 'byteOffset', { configurable: true, get: () => 0 });
    Object.defineProperty(taProto, 'byteLength', { configurable: true, get: () => 64 });
    Object.defineProperty(taProto, 'length', { configurable: true, get: () => 64 });
    clone = structuredClone(victim);
  } catch (e) {
    threw = e;
  } finally {
    for (const [k, d] of saved) Object.defineProperty(taProto, k, d);
  }
  assert.equal(threw, undefined, 'cloning a typed array must not throw under a poisoned window');
  assert.equal(clone.length, 2);
  assert.equal(Buffer.from(clone.buffer, clone.byteOffset, clone.length).toString('latin1'), 'hi');
  assert.equal(secret.length, 39);
}

// The BRAND, not the window. `value instanceof DataView` dispatches through
// `DataView[Symbol.hasInstance]`, which is a configurable own property of the
// constructor — forge it to false and a genuine DataView is misrouted into the
// typed-array arm, where the captured %TypedArray% getter rejects the receiver
// and Lava threw `TypeError: Receiver should be a typed array view` on a value
// node clones fine. Same lesson as the `Symbol.toStringTag` forgery above: a
// brand must come from the prototype chain, which user code cannot re-point on
// an already-constructed object.
{
  const dv = new DataView(new ArrayBuffer(8), 2, 4);
  const had = Object.getOwnPropertyDescriptor(DataView, Symbol.hasInstance);
  let clone, threw;
  try {
    Object.defineProperty(DataView, Symbol.hasInstance, { value: () => false, configurable: true });
    clone = structuredClone(dv);
  } catch (e) {
    threw = e;
  } finally {
    if (had) Object.defineProperty(DataView, Symbol.hasInstance, had);
    else delete DataView[Symbol.hasInstance];
  }
  assert.equal(threw, undefined, 'a forged hasInstance must not break a real DataView clone');
  assert.equal(Object.prototype.toString.call(clone), '[object DataView]');
  assert.equal(clone.byteLength, 4);
}

// The mirror image: forging hasInstance to TRUE must not let a typed array take
// the DataView arm either.
{
  const u = new Uint8Array([1, 2, 3]);
  const had = Object.getOwnPropertyDescriptor(DataView, Symbol.hasInstance);
  let clone, threw;
  try {
    Object.defineProperty(DataView, Symbol.hasInstance, { value: () => true, configurable: true });
    clone = structuredClone(u);
  } catch (e) {
    threw = e;
  } finally {
    if (had) Object.defineProperty(DataView, Symbol.hasInstance, had);
    else delete DataView[Symbol.hasInstance];
  }
  assert.equal(threw, undefined, 'a forged hasInstance must not break a real typed-array clone');
  assert.equal(Object.prototype.toString.call(clone), '[object Uint8Array]');
  assert.deepEqual(Array.from(clone), [1, 2, 3]);
}

console.log('structured-clone-ok');
