// node:sqlite bind/read coercion parity, second pass (#91). The bullets enumerated
// in that issue were fixed by PR #165; a differential probe of the same code paths
// against node 24 found five more divergences of the same class, all pinned here:
//
//   * a JS number bound as SQLite INTEGER instead of REAL — changes arithmetic
//     (integer division) and the on-disk storage class, not just a type tag,
//   * a zero-length Uint8Array binding SQL NULL instead of an empty BLOB,
//   * SQLite-originated errors (open/exec/prepare/step) carrying no `code`, so
//     `err.code === 'ERR_SQLITE_ERROR'` — the documented way to handle them —
//     never matched,
//   * exec()/prepare() coercing a non-string argument with String() instead of
//     throwing ERR_INVALID_ARG_TYPE (and so invoking a caller-supplied toString),
//   * Arrays and functions not being treated as named-parameter bags.
//
// node 24.21 then moved the oracle twice more, pinned at the end: a boolean binds
// as INTEGER 1/0, and an ArrayBuffer/SharedArrayBuffer binds as a BLOB (NULL when
// it is empty) — node 22 threw on the first and read the second as a named bag.
//
// Run under Node as the oracle and compared byte-for-byte against Lava.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

function throwsWith(fn, code, message, label) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, label + ': expected a throw');
  assert.equal(err.code, code, label + ': code');
  if (message !== null) assert.equal(err.message, message, label + ': message');
}

const db = new DatabaseSync(':memory:');

// --- every JS number binds as REAL, exactly as Node does ---
// SQLite applies integer division when BOTH operands are INTEGER, so binding a
// whole number as INTEGER silently changes the arithmetic result.
assert.equal(db.prepare('SELECT typeof(?) AS v').get(42).v, 'real', 'whole number binds REAL');
assert.equal(db.prepare('SELECT ? / 2 AS v').get(5).v, 2.5, 'bound number divides as REAL');
assert.equal(db.prepare('SELECT typeof(?) AS v').get(1.5).v, 'real');
assert.equal(db.prepare('SELECT typeof(?) AS v').get(9007199254740992).v, 'real');
// A BigInt is the way to ask for INTEGER (contrast — this one is not a number).
assert.equal(db.prepare('SELECT typeof(?) AS v').get(42n).v, 'integer');

// The stored storage class follows the bind, so a Lava-written database used to
// differ from a Node-written one for identical code.
db.exec('CREATE TABLE untyped (x)');
db.prepare('INSERT INTO untyped VALUES (?)').run(7);
assert.equal(db.prepare('SELECT typeof(x) AS v FROM untyped').get().v, 'real');
assert.equal(db.prepare('SELECT x AS v FROM untyped').get().v, 7);
// Column affinity still converts losslessly on the way in.
db.exec('CREATE TABLE typed (x INTEGER)');
db.prepare('INSERT INTO typed VALUES (?)').run(7);
assert.equal(db.prepare('SELECT typeof(x) AS v FROM typed').get().v, 'integer');

// --- a zero-length Uint8Array is an empty BLOB, not NULL ---
db.exec('CREATE TABLE blobs (x)');
db.prepare('INSERT INTO blobs VALUES (?)').run(new Uint8Array(0));
const empty = db.prepare('SELECT typeof(x) AS ty, length(x) AS n, x FROM blobs').get();
assert.equal(empty.ty, 'blob', 'empty Uint8Array binds an empty BLOB');
assert.equal(empty.n, 0);
assert.equal(empty.x === null, false);
assert.equal(empty.x.length, 0);
// A non-empty blob is unaffected.
db.exec('DELETE FROM blobs');
db.prepare('INSERT INTO blobs VALUES (?)').run(new Uint8Array([9]));
const one = db.prepare('SELECT typeof(x) AS ty, x FROM blobs').get();
assert.equal(one.ty, 'blob');
assert.deepEqual(Array.from(one.x), [9]);
// A view over a RESIZABLE buffer binds its current bytes. A length-tracking view
// used to store an empty BLOB, and a fixed one the buffer shrank below bound its
// stale bytes: the shared typed-array helper read the view's stored length field.
{
  const rab = new ArrayBuffer(3, { maxByteLength: 8 });
  new Uint8Array(rab).set([1, 2, 3]);
  const blob = (v) => {
    const row = db.prepare('SELECT typeof(?) AS t, ? AS v').get(v, v);
    return row.t + ':' + Array.from(row.v).join(',');
  };
  const tracking = new Uint8Array(rab);
  const window = new Uint8Array(rab, 1, 2);
  assert.equal(blob(tracking), 'blob:1,2,3', 'length-tracking view');
  assert.equal(blob(new Uint8Array(rab, 1)), 'blob:2,3', 'length-tracking view at an offset');
  assert.equal(blob(window), 'blob:2,3', 'fixed view in bounds');
  rab.resize(5);
  assert.equal(blob(tracking), 'blob:1,2,3,0,0', 'length-tracking view after grow');
  rab.resize(2);
  assert.equal(blob(tracking), 'blob:1,2', 'length-tracking view after shrink');
  assert.equal(blob(window), 'blob:', 'fixed view out of bounds is empty');
}

// --- every SQLite-originated error carries code ERR_SQLITE_ERROR ---
throwsWith(() => db.exec('NOT SQL'), 'ERR_SQLITE_ERROR', 'near "NOT": syntax error', 'exec syntax');
throwsWith(
  () => db.prepare('NOT SQL'),
  'ERR_SQLITE_ERROR',
  'near "NOT": syntax error',
  'prepare syntax',
);
db.exec('CREATE TABLE uniq (x UNIQUE)');
db.prepare('INSERT INTO uniq VALUES (1)').run();
throwsWith(
  () => db.prepare('INSERT INTO uniq VALUES (1)').run(),
  'ERR_SQLITE_ERROR',
  'UNIQUE constraint failed: uniq.x',
  'constraint from step',
);
// A failed open reports the same code (message is filesystem-dependent).
throwsWith(
  () => new DatabaseSync('/nonexistent-lava-sqlite-dir/x.db'),
  'ERR_SQLITE_ERROR',
  null,
  'open failure',
);

// --- exec()/prepare() type-check their SQL instead of stringifying it ---
const SQL_TYPE_MSG = 'The "sql" argument must be a string.';
throwsWith(() => db.exec(5), 'ERR_INVALID_ARG_TYPE', SQL_TYPE_MSG, 'exec number');
throwsWith(() => db.prepare(5), 'ERR_INVALID_ARG_TYPE', SQL_TYPE_MSG, 'prepare number');
throwsWith(() => db.exec(null), 'ERR_INVALID_ARG_TYPE', SQL_TYPE_MSG, 'exec null');
throwsWith(() => db.exec(undefined), 'ERR_INVALID_ARG_TYPE', SQL_TYPE_MSG, 'exec undefined');
throwsWith(() => db.exec(), 'ERR_INVALID_ARG_TYPE', SQL_TYPE_MSG, 'exec no args');
// The rejection happens before any coercion, so a caller-supplied toString never runs.
let toStringCalls = 0;
throwsWith(
  () =>
    db.exec({
      toString() {
        toStringCalls++;
        return 'SELECT 1';
      },
    }),
  'ERR_INVALID_ARG_TYPE',
  SQL_TYPE_MSG,
  'exec object',
);
assert.equal(toStringCalls, 0);

// --- Arrays and functions are named-parameter bags, like any other object ---
// An array's index keys are read as parameter names, so they match no placeholder.
throwsWith(
  () => db.prepare('SELECT ? AS v').get([1]),
  'ERR_INVALID_STATE',
  "Unknown named parameter '0'",
  'array bag',
);
// An empty array (or a function) carries no keys: the anonymous "?" binds NULL.
assert.equal(db.prepare('SELECT ? AS v').get([]).v, null);
assert.equal(db.prepare('SELECT ? AS v').get(function () {}).v, null);

// --- a boolean binds as INTEGER 1/0 (node 24.x) ---
const typed1 = db.prepare('SELECT ? AS v, typeof(?) AS t');
assert.deepEqual({ ...typed1.get(true, true) }, { v: 1, t: 'integer' });
assert.deepEqual({ ...typed1.get(false, false) }, { v: 0, t: 'integer' });
assert.equal(db.prepare('SELECT :a AS v').get({ a: true }).v, 1, 'named boolean');
// A leading boolean is a value, not a bag: it fills "?" and the extra arg overflows.
throwsWith(
  () => db.prepare('SELECT ? AS v').get(true, 1),
  'ERR_SQLITE_ERROR',
  'column index out of range',
  'boolean is not a bag',
);

// --- an ArrayBuffer / SharedArrayBuffer binds its bytes as a BLOB (node 24.x) ---
const blobOf = (v) => {
  const row = db.prepare('SELECT ? AS v, typeof(?) AS t').get(v, v);
  return row.t + ':' + (row.v === null ? 'null' : Array.from(row.v).join(','));
};
assert.equal(blobOf(new Uint8Array([1, 2, 3]).buffer), 'blob:1,2,3');
// Lava's JSC build has no SharedArrayBuffer global; the lines still pin node here and
// hold Lava to the same answer the day it gains one.
const hasSAB = typeof SharedArrayBuffer === 'function';
if (hasSAB) {
  const sab = new SharedArrayBuffer(2);
  new Uint8Array(sab)[1] = 5;
  assert.equal(blobOf(sab), 'blob:0,5');
}
class SubBuffer extends ArrayBuffer {}
assert.equal(blobOf(new SubBuffer(1)), 'blob:0', 'subclass');
// Unlike an empty Uint8Array, an EMPTY buffer binds NULL — and so does a detached one.
assert.equal(blobOf(new ArrayBuffer(0)), 'null:null');
if (hasSAB) assert.equal(blobOf(new SharedArrayBuffer(0)), 'null:null');
const detached = new ArrayBuffer(2);
detached.transfer();
assert.equal(blobOf(detached), 'null:null', 'detached');
assert.deepEqual(
  Array.from(db.prepare('SELECT :a AS v').get({ a: new ArrayBuffer(1) }).v),
  [0],
  'named buffer',
);
// The test is the real brand, not the tag: a look-alike is still a bag. (Its tag
// sits on a non-plain prototype, as a class instance's would.)
const lookAlike = Object.create({ [Symbol.toStringTag]: 'ArrayBuffer' });
lookAlike.byteLength = 2;
throwsWith(
  () => db.prepare('SELECT ? AS v').get(lookAlike),
  'ERR_INVALID_STATE',
  "Unknown named parameter 'byteLength'",
  'spoofed tag',
);
assert.equal(db.prepare('SELECT ? AS v').get(Object.create(ArrayBuffer.prototype)).v, null);

db.close();
console.log('ok');
