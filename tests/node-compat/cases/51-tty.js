// node:tty — isatty is backed by the native syscall (Linux); the WriteStream/ReadStream
// surface is feature-detection only. Asserts the parts that match Node deterministically:
// isatty for invalid / not-open fds (fd 99999 exercises the native isatty(2) -> EBADF ->
// false path), and the constructor + prototype shape. Stream construction on a non-tty fd
// is intentionally forgiving in lava (no ERR_TTY_INIT_FAILED), so it is not asserted here.
const assert = require('node:assert/strict');
const tty = require('node:tty');

assert.equal(tty.isatty(-1), false);
assert.equal(tty.isatty(1.5), false);
assert.equal(tty.isatty(99999), false);
assert.equal(tty.isatty('x'), false);
assert.equal(tty.isatty(NaN), false);

assert.equal(typeof tty.WriteStream, 'function');
assert.equal(typeof tty.ReadStream, 'function');
assert.equal(typeof tty.WriteStream.prototype.getColorDepth, 'function');
assert.equal(typeof tty.WriteStream.prototype.hasColors, 'function');
assert.equal(typeof tty.WriteStream.prototype.getWindowSize, 'function');
assert.equal(typeof tty.ReadStream.prototype.setRawMode, 'function');

console.log('ok');
