// 64-bit integer handling for node:sqlite (#131). SQLite INTEGER is i64; JS
// numbers are exact only to 2^53-1. Match Node: read out-of-range columns throw
// ERR_OUT_OF_RANGE by default, setReadBigInts(true) returns BigInt, and run()'s
// changes/lastInsertRowid are lossy numbers by default / BigInt when opted in.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (x INTEGER)');

// In-range integer is a plain number.
db.exec('INSERT INTO t VALUES (42)');
let s = db.prepare('SELECT x FROM t');
assert.equal(s.get().x, 42);
assert.equal(typeof s.get().x, 'number');

// Out-of-range integer (i64 max) throws ERR_OUT_OF_RANGE by default.
db.exec('DELETE FROM t; INSERT INTO t VALUES (9223372036854775807)');
s = db.prepare('SELECT x FROM t');
let err;
try {
  s.get();
} catch (e) {
  err = e;
}
assert.ok(err, 'expected out-of-range read to throw');
assert.equal(err.code, 'ERR_OUT_OF_RANGE');

// setReadBigInts(true) returns the value as BigInt (in range or out).
assert.equal(s.setReadBigInts(true), undefined);
assert.equal(s.get().x, 9223372036854775807n);
const s2 = db.prepare('SELECT x FROM t');
s2.setReadBigInts(true);
db.exec('DELETE FROM t; INSERT INTO t VALUES (5)');
assert.equal(s2.get().x, 5n);

// The 2^53-1 boundary: exactly safe is a number; one beyond throws.
function readOne(val) {
  db.exec('DELETE FROM t; INSERT INTO t VALUES (' + val + ')');
  return db.prepare('SELECT x FROM t').get().x;
}
assert.equal(readOne('9007199254740991'), 9007199254740991);
let boundary;
try {
  readOne('9007199254740992');
} catch (e) {
  boundary = e;
}
assert.equal(boundary && boundary.code, 'ERR_OUT_OF_RANGE');

// run(): changes/lastInsertRowid are numbers by default (lossy, never throw),
// BigInt under setReadBigInts(true).
db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY)');
const ins = db.prepare('INSERT INTO u (id) VALUES (9007199254740995)');
const r = ins.run();
assert.equal(typeof r.lastInsertRowid, 'number');
assert.equal(typeof r.changes, 'number');

const insBig = db.prepare('INSERT INTO u (id) VALUES (9007199254740999)');
insBig.setReadBigInts(true);
const r2 = insBig.run();
assert.equal(r2.lastInsertRowid, 9007199254740999n);
assert.equal(r2.changes, 1n);

console.log('ok');
