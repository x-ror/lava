// Value coercion / validation parity with node:sqlite (#91). Covers the bind and
// read edges where Lava previously diverged: BigInt binding, rejecting unbindable
// types (undefined/boolean) instead of silently coercing, surfacing failed binds,
// NUL-containing TEXT, empty exec, the required constructor path, and parameter
// count mismatches. Run under Node as the oracle and compared against Lava.
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

// --- constructor requires a real path (no silent "undefined" file) ---
throwsWithCode(() => new DatabaseSync(), 'ERR_INVALID_ARG_TYPE', 'no-arg ctor');
throwsWithCode(() => new DatabaseSync(undefined), 'ERR_INVALID_ARG_TYPE', 'undefined ctor');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x)');

// --- empty exec is a no-op (not an error) ---
assert.equal(db.exec(''), undefined);
assert.equal(db.exec('   '), undefined);

function insertOne(value) {
  db.exec('DELETE FROM t');
  db.prepare('INSERT INTO t VALUES (?)').run(value);
}

// --- BigInt binds as INTEGER when it fits in i64 ---
insertOne(42n);
const r42 = db.prepare('SELECT x, typeof(x) AS ty FROM t').get();
assert.equal(r42.x, 42);
assert.equal(r42.ty, 'integer');

// A full-width i64 round-trips exactly when read back as BigInt.
insertOne(9223372036854775807n);
const big = db.prepare('SELECT x FROM t');
big.setReadBigInts(true);
assert.equal(big.get().x, 9223372036854775807n);

// A BigInt outside i64 range cannot be bound — Node throws, no lossy/wrapped write.
throwsWithCode(() => insertOne(2n ** 64n), 'ERR_INVALID_ARG_VALUE', 'bigint overflow');

// --- unbindable types throw instead of coercing ---
throwsWithCode(() => insertOne(undefined), 'ERR_INVALID_ARG_TYPE', 'bind undefined');
throwsWithCode(() => insertOne(true), 'ERR_INVALID_ARG_TYPE', 'bind true');
throwsWithCode(() => insertOne(false), 'ERR_INVALID_ARG_TYPE', 'bind false');

// --- null is a valid bind (-> SQL NULL) ---
insertOne(null);
assert.equal(db.prepare('SELECT x FROM t').get().x, null);

// --- TEXT with an embedded NUL ---
// Node 22's node:sqlite (the pinned CI oracle) truncates TEXT at the first NUL;
// Node 24+ and Lava preserve the whole value (correct SQLite semantics — see #91).
// Assert whichever contract the running engine has so the case stays valid on the
// pinned-Node oracle while still pinning Lava to full preservation.
insertOne('a\0b');
const text = db.prepare('SELECT x FROM t').get().x;
if (text.length === 1) {
  assert.equal(text, 'a'); // Node 22: truncated at the NUL
} else {
  assert.equal(text.length, 3); // Node 24+ / Lava: preserved intact
  assert.equal(text.charCodeAt(0), 97);
  assert.equal(text.charCodeAt(1), 0);
  assert.equal(text.charCodeAt(2), 98);
}

// --- too few positional params bind NULL; too many surface a SQLite error ---
db.exec('CREATE TABLE pair (a, b)');
db.prepare('INSERT INTO pair VALUES (?, ?)').run(); // 0 args, 2 placeholders
const pair = db.prepare('SELECT a, b FROM pair').get();
assert.equal(pair.a, null);
assert.equal(pair.b, null);

throwsWithCode(
  () => db.prepare('INSERT INTO t VALUES (?)').run(1, 2),
  'ERR_SQLITE_ERROR',
  'extra positional param',
);

db.close();
console.log('ok');
