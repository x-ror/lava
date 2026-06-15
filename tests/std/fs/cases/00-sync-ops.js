// Cross-platform node:fs sync-op coverage, diffed against Node as oracle on
// Linux, macOS, AND Windows. This complements tests/node-compat/cases/02-fs-path.js,
// which is intentionally POSIX-path-shaped (asserts path.sep === '/', uses /tmp)
// and so only runs on Linux/macOS. This case uses path.join everywhere and an
// OS-appropriate temp dir so it runs identically on all three platforms.
//
// Design: error cases PRINT their observable result (code + syscall, never an
// absolute path), so the node-vs-lava comparison is itself the judge of
// per-platform parity — the test hard-codes no platform-specific error codes.
// Success cases use assert() for invariants that hold everywhere. Every native
// fs method is exercised: readFile(Sync), writeFile(Sync), existsSync, statSync,
// readdirSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, renameSync.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// err(label, fn) prints "label CODE SYSCALL" when fn throws (or "label NO-THROW"
// if it unexpectedly succeeds). The node-vs-lava diff fails on any difference, so
// a per-platform code mismatch between the runtimes is caught without this test
// having to know each platform's expected code.
function err(label, fn) {
  try {
    fn();
    console.log(label, 'NO-THROW');
  } catch (e) {
    console.log(label, e.code, e.syscall);
  }
}

// Isolated scratch root via mkdtempSync (also exercises it). node and lava each
// get a unique dir; nothing prints the absolute path so stdout stays identical.
const tmpBase = (process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp').replace(
  /[\\/]+$/,
  '',
);
const root = fs.mkdtempSync(path.join(tmpBase, 'lava-fs-'));
assert.equal(fs.statSync(root).isDirectory(), true);

// mkdirSync (+ recursive); a non-recursive mkdir on an existing path throws.
const nested = path.join(root, 'a', 'b', 'c');
fs.mkdirSync(nested, { recursive: true });
assert.equal(fs.existsSync(nested), true);
err('mkdir-existing', () => fs.mkdirSync(path.join(root, 'a')));

// writeFileSync (string + bytes) round-trips through readFileSync.
const noteFile = path.join(root, 'note.txt');
fs.writeFileSync(noteFile, 'lava fs');
assert.equal(fs.readFileSync(noteFile, 'utf8'), 'lava fs');
const binFile = path.join(root, 'bytes.bin');
fs.writeFileSync(binFile, new Uint8Array([7, 8, 9]));
assert.equal(fs.readFileSync(binFile).length, 3);

// statSync on a file and a missing path.
assert.equal(fs.statSync(noteFile).isFile(), true);
assert.equal(fs.statSync(noteFile).size, 7);
err('stat-missing', () => fs.statSync(path.join(root, 'nope')));

// readdirSync lists what was created (sorted for a stable comparison).
console.log('readdir', fs.readdirSync(root).sort().join(','));

// renameSync moves a file; a missing source throws.
const renamed = path.join(root, 'renamed.txt');
fs.renameSync(noteFile, renamed);
assert.equal(fs.existsSync(noteFile), false);
assert.equal(fs.readFileSync(renamed, 'utf8'), 'lava fs');
err('rename-missing', () => fs.renameSync(path.join(root, 'nope'), path.join(root, 'x')));

// unlinkSync removes a file; a second unlink and an unlink-on-directory throw
// (the directory code differs by platform — EISDIR on Linux, EPERM elsewhere —
// which is exactly what the printed diff verifies).
fs.unlinkSync(renamed);
assert.equal(fs.existsSync(renamed), false);
err('unlink-missing', () => fs.unlinkSync(renamed));
err('unlink-dir', () => fs.unlinkSync(path.join(root, 'a')));

// rmdirSync removes an empty directory; missing, on-a-file, and non-empty throw.
const emptyDir = path.join(root, 'empty');
fs.mkdirSync(emptyDir);
fs.rmdirSync(emptyDir);
assert.equal(fs.existsSync(emptyDir), false);
err('rmdir-missing', () => fs.rmdirSync(emptyDir));
err('rmdir-file', () => fs.rmdirSync(binFile));
err('rmdir-nonempty', () => fs.rmdirSync(path.join(root, 'a')));

// mkdtempSync: literal prefix, unique per call, and the buffer-encoding return.
const t1 = fs.mkdtempSync(path.join(root, 'tmp-'));
const t2 = fs.mkdtempSync(path.join(root, 'tmp-'));
assert.notEqual(t1, t2);
assert.equal(path.basename(t1).startsWith('tmp-'), true);
assert.equal(fs.statSync(t1).isDirectory(), true);
const buf = fs.mkdtempSync(path.join(root, 'buf-'), 'buffer');
assert.equal(buf instanceof Uint8Array, true);
assert.equal(fs.statSync(new TextDecoder().decode(buf)).isDirectory(), true);
err('mkdtemp-bad-parent', () => fs.mkdtempSync(path.join(root, 'no-such-parent', 'p-')));

// Async writeFile -> readFile round-trip, then full recursive teardown via rmSync.
// The trailing sentinel proves the async chain ran (a silent skip can't pass).
fs.writeFile(path.join(root, 'async.txt'), 'async fs', (writeErr) => {
  assert.equal(writeErr, null);
  fs.readFile(path.join(root, 'async.txt'), 'utf8', (readErr, contents) => {
    assert.equal(readErr, null);
    assert.equal(contents, 'async fs');
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
    console.log('fs-ok');
  });
});
