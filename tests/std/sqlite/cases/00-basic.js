const assert = require('node:assert/strict');
const {DatabaseSync} = require('node:sqlite');

const db = new DatabaseSync(':memory:');

db.exec(`
	CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL
	);
	INSERT INTO users (name) VALUES ('Ada');
`);

const row = db.prepare('SELECT id, name FROM users WHERE name = ?').get('Ada');

assert.equal(row.id, 1);
assert.equal(row.name, 'Ada');
assert.equal(db.isOpen, true);

db.exec('CREATE TABLE blobs (value BLOB)');
db.prepare('INSERT INTO blobs (value) VALUES (?)').run(Buffer.from('AAAAAAAABBBBBBBB').subarray(8));
const blobRow = db.prepare('SELECT value FROM blobs').get();
assert.deepEqual(Array.from(blobRow.value), Array.from(Buffer.from('BBBBBBBB')));

db.close();
assert.equal(db.isOpen, false);
