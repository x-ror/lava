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

db.close();
console.log('ok');
