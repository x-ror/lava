// Statement / connection lifecycle parity with node:sqlite (issue #90).
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// Preparing many statements then closing must not require any manual finalize:
// db.close() finalizes them all (no zombie connection, no leaked sqlite3_stmt).
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');
let last;
for (let i = 0; i < 1000; i++) {
  last = db.prepare('SELECT ? AS x');
}
assert.equal(last.get(7).x, 7);

db.close();
assert.equal(db.isOpen, false);

// Using a statement after the database is closed throws like Node: closing the
// connection finalizes its statements, so they report as finalized.
let threw;
try {
  last.get(1);
} catch (e) {
  threw = e;
}
assert.ok(threw, 'expected statement use after close to throw');
assert.equal(threw.message, 'statement has been finalized');
assert.equal(threw.code, 'ERR_INVALID_STATE');

// Closing an already-closed database throws, like Node.
let closeErr;
try {
  db.close();
} catch (e) {
  closeErr = e;
}
assert.ok(closeErr, 'expected double close to throw');
assert.equal(closeErr.message, 'database is not open');
assert.equal(closeErr.code, 'ERR_INVALID_STATE');

console.log('ok');
