// fs.openSync / fs.closeSync (fd-based). Returns a real OS file descriptor (Linux-first;
// Windows is stubbed as ENOSYS, but CI runs Linux only). Asserts the parts that match
// Node deterministically: an fd is a non-negative integer, create-on-write, read of an
// existing file, and the ENOENT / EEXIST / EBADF error codes. fd VALUES are not compared
// (they differ between runtimes) — only their shape and the error codes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-fd-'));
const file = path.join(dir, 'f.txt');

// 'w' creates the file; the fd is a non-negative integer.
const wfd = fs.openSync(file, 'w');
assert.equal(typeof wfd, 'number');
assert.ok(Number.isInteger(wfd) && wfd >= 0);
fs.closeSync(wfd);

// 'r' opens the now-existing file.
const rfd = fs.openSync(file, 'r');
assert.ok(Number.isInteger(rfd) && rfd >= 0);
fs.closeSync(rfd);

// Default flags is 'r': a missing file is ENOENT.
assert.throws(() => fs.openSync(path.join(dir, 'missing')), { code: 'ENOENT' });
// Exclusive create over an existing file is EEXIST.
assert.throws(() => fs.openSync(file, 'wx'), { code: 'EEXIST' });
// Closing a fd that was never opened is EBADF; the error is path-less.
assert.throws(() => fs.closeSync(99999), {
  code: 'EBADF',
  message: 'EBADF: bad file descriptor, close',
});

// fd / mode are validated BEFORE the syscall (so a bad arg can never close an unrelated
// descriptor): a non-integer / negative / out-of-range number is ERR_OUT_OF_RANGE, a
// non-number is ERR_INVALID_ARG_TYPE — matching Node's validateInt32 / parseFileMode.
assert.throws(() => fs.closeSync(-1), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => fs.closeSync(3.5), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => fs.closeSync(NaN), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => fs.closeSync(2 ** 32), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => fs.closeSync('3'), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => fs.closeSync({}), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => fs.openSync(file, 'r', 1.5), { code: 'ERR_OUT_OF_RANGE' });

fs.rmSync(dir, { recursive: true, force: true });
console.log('ok');
