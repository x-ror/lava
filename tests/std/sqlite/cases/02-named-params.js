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

// Node accepts BOTH key forms for a named placeholder: the bare name and the
// exact sigil-prefixed name. Only the bare form used to work, so the documented
// { $a: 1 } style threw "Unknown named parameter '$a'" (#91).
assert.equal(db.prepare('SELECT $a AS v').get({ $a: 7 }).v, 7);
assert.equal(db.prepare('SELECT :a AS v').get({ ':a': 7 }).v, 7);
assert.equal(db.prepare('SELECT @a AS v').get({ '@a': 7 }).v, 7);
// A repeated placeholder is a single parameter, reachable by either key form.
assert.equal(db.prepare('SELECT $a + $a AS v').get({ $a: 3 }).v, 6);
// When a bag carries both forms the BARE key wins.
assert.equal(db.prepare('SELECT $a AS v').get({ $a: 1, a: 2 }).v, 2);
// A key with a foreign sigil still names no placeholder: ':a' is not '$a'.
let crossSigil;
try {
  db.prepare('SELECT $a AS v').get({ ':a': 7 });
} catch (e) {
  crossSigil = e;
}
assert.equal(crossSigil && crossSigil.code, 'ERR_INVALID_STATE');
assert.equal(crossSigil.message, "Unknown named parameter ':a'");

// A Uint8Array first argument is a blob value, not a named-parameter bag.
db.exec('CREATE TABLE b (v BLOB)');
db.prepare('INSERT INTO b VALUES (?)').run(new Uint8Array([1, 2, 3]));
assert.deepEqual(Array.from(db.prepare('SELECT v FROM b').get().v), [1, 2, 3]);

db.close();
