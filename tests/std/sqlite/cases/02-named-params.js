const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (id INTEGER, name TEXT)');

// Named parameters with mixed :name, @name and $name sigils.
const ins = db.prepare('INSERT INTO t (id, name) VALUES (:id, $name)');
ins.run({ id: 1, name: 'Ada' });
ins.run({ id: 2, name: 'Grace' });

assert.equal(db.prepare('SELECT name FROM t WHERE id = @id').get({ id: 2 }).name, 'Grace');

// Positional binding still works on the same connection.
assert.equal(db.prepare('SELECT name FROM t WHERE id = ?').get(1).name, 'Ada');

// A leading named-parameter object plus a trailing anonymous "?" parameter.
const mixed = db.prepare('SELECT id FROM t WHERE id = :id OR name = ? ORDER BY id');
assert.deepEqual(
  mixed.all({ id: 1 }, 'Grace').map((r) => r.id),
  [1, 2],
);

// An unmatched named parameter binds as NULL (no row, no throw).
assert.equal(db.prepare('SELECT name FROM t WHERE id = :id').get({}), undefined);

// A Uint8Array first argument is a blob value, not a named-parameter bag.
db.exec('CREATE TABLE b (v BLOB)');
db.prepare('INSERT INTO b VALUES (?)').run(new Uint8Array([1, 2, 3]));
assert.deepEqual(Array.from(db.prepare('SELECT v FROM b').get().v), [1, 2, 3]);

db.close();
