const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'hello.txt');
const text = fs.readFileSync(fixturePath, 'utf8').trim();

assert.equal(text, 'hello from a node compatibility fixture');
assert.equal(path.extname(fixturePath), '.txt');
assert.equal(path.isAbsolute(fixturePath), true);
assert.equal(fs.existsSync(fixturePath), true);

