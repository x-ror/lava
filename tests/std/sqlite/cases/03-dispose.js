// Deterministic cleanup for node:sqlite (#128). StatementSync.finalize() and
// [Symbol.dispose] on StatementSync are Lava extensions (Node's node:sqlite has
// neither), so they are feature-detected here: the assertions run on Lava and are
// skipped on Node, keeping this oracle case byte-identical on both engines.
// DatabaseSync[Symbol.dispose] exists on Node too and is asserted on both.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');

// Public finalize() releases the statement; using it afterwards throws like a
// finalized statement (ERR_INVALID_STATE). (Lava extension — skipped on Node.)
const stmt = db.prepare('INSERT INTO t (x) VALUES (?)');
stmt.run(1);
if (typeof stmt.finalize === 'function') {
  stmt.finalize();
  stmt.finalize(); // idempotent
  let afterFinalize;
  try {
    stmt.run(2);
  } catch (e) {
    afterFinalize = e;
  }
  assert.ok(afterFinalize, 'expected use after finalize() to throw');
  assert.equal(afterFinalize.code, 'ERR_INVALID_STATE');

  // [Symbol.dispose] on a statement is an alias of finalize() (Lava extension).
  const stmt2 = db.prepare('SELECT 1 AS x');
  if (typeof stmt2[Symbol.dispose] === 'function') {
    stmt2[Symbol.dispose]();
    let disposed;
    try {
      stmt2.get();
    } catch (e) {
      disposed = e;
    }
    assert.equal(disposed && disposed.code, 'ERR_INVALID_STATE');
  }
}

// Preparing many statements with no manual finalize must not collide in the
// null-proto live-statement map, and close must still finalize them all.
for (let i = 0; i < 50; i++) db.prepare('SELECT ? AS x');

// DatabaseSync[Symbol.dispose] closes the connection (present on Node too).
if (typeof db[Symbol.dispose] === 'function') {
  db[Symbol.dispose]();
} else {
  db.close();
}
assert.equal(db.isOpen, false);

console.log('ok');
