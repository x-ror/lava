// Parameter and path-type parity with node:sqlite (review follow-up to #91):
// Buffer/Uint8Array path inputs, DataView blob binding, rejection of a bare
// ArrayBuffer, and validation of named-parameter objects (unknown keys throw
// unless setAllowUnknownNamedParameters). Diffed against Node as the oracle.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

function throwsWithCode(fn, code, label) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, label + ': expected a throw');
  assert.equal(err.code, code, label + ': code');
}

// --- path may be a Buffer or Uint8Array (decoded as UTF-8 path bytes) ---
{
  const dbBuf = new DatabaseSync(Buffer.from(':memory:'));
  dbBuf.exec('CREATE TABLE t (x)');
  dbBuf.prepare('INSERT INTO t VALUES (1)').run();
  assert.equal(dbBuf.prepare('SELECT x FROM t').get().x, 1);
  dbBuf.close();

  const dbU8 = new DatabaseSync(new TextEncoder().encode(':memory:'));
  assert.equal(dbU8.isOpen, true);
  dbU8.close();
}

const db = new DatabaseSync(':memory:');

// --- DataView binds as a BLOB (like a TypedArray) ---
db.exec('CREATE TABLE b (v BLOB)');
db.prepare('INSERT INTO b VALUES (?)').run(new DataView(new Uint8Array([4, 5, 6]).buffer));
assert.deepEqual(Array.from(db.prepare('SELECT v FROM b').get().v), [4, 5, 6]);

// A bare ArrayBuffer is not an ArrayBuffer view, so (like node:sqlite) it is
// consumed as an empty named-params bag and the bound parameter becomes NULL.
db.exec('DELETE FROM b');
db.prepare('INSERT INTO b VALUES (?)').run(new ArrayBuffer(3));
assert.equal(db.prepare('SELECT v FROM b').get().v, null);

// --- named parameters: unknown keys are rejected, missing keys bind NULL ---
const sel = db.prepare('SELECT :a AS a');
assert.equal(sel.get({ a: 1 }).a, 1);
assert.equal(sel.get({}).a, null); // missing key -> NULL
throwsWithCode(() => sel.get({ a: 1, b: 2 }), 'ERR_INVALID_STATE', 'unknown named key');

// An object passed to a statement with only anonymous "?" placeholders is treated
// as a (fully unknown) named bag — its key matches nothing, so it throws.
db.exec('CREATE TABLE t (x)');
throwsWithCode(
  () => db.prepare('INSERT INTO t VALUES (?)').run({ a: 1 }),
  'ERR_INVALID_STATE',
  'object into ? placeholder',
);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0); // nothing inserted

// setAllowUnknownNamedParameters(true) suppresses the unknown-key error.
const lenient = db.prepare('SELECT :a AS a');
lenient.setAllowUnknownNamedParameters(true);
assert.equal(lenient.get({ a: 1, b: 2 }).a, 1);

db.close();
console.log('ok');
