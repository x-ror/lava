const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'hello.txt');
const text = fs.readFileSync(fixturePath, 'utf8').trim();

assert.equal(text, 'hello from a node compatibility fixture');
assert.equal(path.extname(fixturePath), '.txt');
assert.equal(path.isAbsolute(fixturePath), true);
assert.equal(fs.existsSync(fixturePath), true);

// --- expanded node:path surface (POSIX default on this platform) ---

assert.equal(path.sep, '/');
assert.equal(path.delimiter, ':');

// dirname / basename / extname
assert.equal(path.dirname('/a/b/c.js'), '/a/b');
assert.equal(path.dirname('/a/b/'), '/a');
assert.equal(path.dirname('foo'), '.');
assert.equal(path.dirname('/'), '/');
assert.equal(path.basename('/a/b/c.js'), 'c.js');
assert.equal(path.basename('/a/b/c.js', '.js'), 'c');
assert.equal(path.basename('/a/b/'), 'b');
assert.equal(path.extname('index.html'), '.html');
assert.equal(path.extname('a.b.c'), '.c');
assert.equal(path.extname('.gitignore'), '');
assert.equal(path.extname('noext'), '');

// normalize
assert.equal(path.normalize('/foo/bar//baz/asdf/quux/..'), '/foo/bar/baz/asdf');
assert.equal(path.normalize('a/b/../c'), 'a/c');
assert.equal(path.normalize('a/../../b'), '../b');
assert.equal(path.normalize('foo/bar/'), 'foo/bar/');
assert.equal(path.normalize(''), '.');

// join
assert.equal(path.join('a', 'b', 'c'), 'a/b/c');
assert.equal(path.join('/a', 'b', '..', 'c'), '/a/c');
assert.equal(path.join('a', '', 'b'), 'a/b');
assert.equal(path.join(), '.');

// resolve (anchored to an absolute first arg so it is cwd-independent)
assert.equal(path.resolve('/foo/bar', './baz'), '/foo/bar/baz');
assert.equal(path.resolve('/foo/bar', '../baz'), '/foo/baz');
assert.equal(path.resolve('/a', '/b', 'c'), '/b/c');
// a relative resolve is rooted at cwd; assert its shape, not the absolute prefix
const rel = path.resolve('x', 'y');
assert.equal(path.isAbsolute(rel), true);
assert.equal(rel.endsWith('/x/y'), true);

// relative
assert.equal(path.relative('/a/b/c', '/a/b/d'), '../d');
assert.equal(path.relative('/a/b', '/a/b/c/d'), 'c/d');
assert.equal(path.relative('/a/b/c/d', '/a/b'), '../..');
assert.equal(path.relative('/a/b', '/a/b'), '');

// parse / format round-trip
const parsed = path.parse('/home/user/file.txt');
assert.deepEqual(parsed, {root: '/', dir: '/home/user', base: 'file.txt', ext: '.txt', name: 'file'});
assert.equal(path.format(parsed), '/home/user/file.txt');
assert.equal(path.format({dir: '/a', base: 'b.js'}), '/a/b.js');

// posix and win32 are always reachable as sub-namespaces
assert.equal(path.posix.join('a', 'b'), 'a/b');
assert.equal(path.posix.sep, '/');
assert.equal(path.win32.join('C:\\', 'a', 'b'), 'C:\\a\\b');
assert.equal(path.win32.normalize('C:\\a\\..\\b'), 'C:\\b');
assert.equal(path.win32.dirname('C:\\a\\b.txt'), 'C:\\a');
assert.equal(path.win32.basename('C:\\a\\b.txt'), 'b.txt');
assert.equal(path.win32.isAbsolute('C:\\a'), true);
assert.equal(path.win32.relative('C:\\a\\b', 'C:\\a\\c'), '..\\c');
assert.equal(path.win32.sep, '\\');
assert.equal(path.posix.win32, path.win32);
assert.equal(path.win32.posix, path.posix);

// --- expanded node:fs surface (write / mkdir / stat / readdir / rm) ---

// statSync / readdirSync on the existing read-only fixtures.
const fixturesDir = path.join(__dirname, '..', 'fixtures');
assert.equal(fs.statSync(fixturePath).isFile(), true);
assert.equal(fs.statSync(fixturePath).isDirectory(), false);
assert.equal(fs.statSync(fixturePath).size, 41);
assert.equal(typeof fs.statSync(fixturePath).mtimeMs, 'number');
assert.equal(fs.statSync(fixturesDir).isDirectory(), true);
assert.equal(fs.readdirSync(fixturesDir).includes('hello.txt'), true);

// Writes go to a pid-namespaced scratch dir so the node and lava runs never
// collide; each run creates it fresh and removes it at the end.
const scratch = path.join(process.env.TMPDIR || '/tmp', 'lava-fs-compat-' + process.pid);
fs.rmSync(scratch, {recursive: true, force: true});

// mkdirSync (recursive) then a non-recursive mkdir on an existing dir throws.
fs.mkdirSync(path.join(scratch, 'nested'), {recursive: true});
assert.equal(fs.existsSync(path.join(scratch, 'nested')), true);
assert.throws(() => fs.mkdirSync(scratch), (e) => e.code === 'EEXIST');

// writeFileSync (string and Uint8Array) round-trips through readFileSync.
const textFile = path.join(scratch, 'note.txt');
fs.writeFileSync(textFile, 'lava fs');
assert.equal(fs.readFileSync(textFile, 'utf8'), 'lava fs');
fs.writeFileSync(path.join(scratch, 'bytes.bin'), new Uint8Array([7, 8, 9]));
assert.equal(fs.readFileSync(path.join(scratch, 'bytes.bin')).length, 3);

// statSync on the written file; readdirSync lists what was created (sorted).
assert.equal(fs.statSync(textFile).size, 7);
assert.deepEqual(fs.readdirSync(scratch).sort(), ['bytes.bin', 'nested', 'note.txt']);

// statSync on a missing path throws ENOENT.
assert.throws(() => fs.statSync(path.join(scratch, 'nope')), (e) => e.code === 'ENOENT');

// Async writeFile -> readFile round-trip, then recursive cleanup. The sentinel
// console.log proves the async chain ran (so a silent skip can't pass).
fs.writeFile(path.join(scratch, 'async.txt'), 'async fs', (writeErr) => {
	assert.equal(writeErr, null);
	fs.readFile(path.join(scratch, 'async.txt'), 'utf8', (readErr, contents) => {
		assert.equal(readErr, null);
		assert.equal(contents, 'async fs');
		fs.rmSync(scratch, {recursive: true, force: true});
		assert.equal(fs.existsSync(scratch), false);
		console.log('fs-extended-ok');
	});
});

