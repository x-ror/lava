// Async fs.readFile / fs.writeFile, now backed by the worker pool (the blocking I/O
// runs off the event loop; the callback is delivered on the poll phase). Exercises the
// (err, data) convention, a write→read round-trip, a Buffer vs utf8-string result, and
// an ENOENT error — all delivered asynchronously through the loop. Node and Lava must
// produce identical output. Runs on every platform via run-fs-oracle.sh, so it covers
// the pool path on Windows against lava.exe too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-fs-async-'));
const file = path.join(dir, 'data.txt');
const payload = Buffer.from('hello from lava — async fs ☕\n', 'utf8');

fs.writeFile(file, payload, (writeErr) => {
  assert.equal(writeErr, null);

  fs.readFile(file, (readErr, buf) => {
    assert.equal(readErr, null);
    // Lava's readFile yields a Uint8Array (Node's Buffer is one too), so compare bytes
    // without relying on Buffer-only methods — keeps node and lava output identical.
    assert.ok(buf instanceof Uint8Array);
    assert.equal(buf.length, payload.length);
    assert.equal(Buffer.from(buf).toString('utf8'), payload.toString('utf8'));

    fs.readFile(file, 'utf8', (strErr, text) => {
      assert.equal(strErr, null);
      assert.equal(typeof text, 'string');
      assert.equal(text, payload.toString('utf8'));

      fs.readFile(path.join(dir, 'does-not-exist.txt'), (missErr, missing) => {
        assert.ok(missErr, 'reading a missing file must error');
        assert.equal(missErr.code, 'ENOENT');
        assert.equal(missing, undefined);

        // Async WRITE error: writing under a missing parent directory fails. Exercises
        // fs_write_work's error population + fs_op_complete_cb's error branch end-to-end.
        // Assert only the shape (a non-empty code string + numeric errno), not an exact
        // code, so node and lava agree across platforms.
        fs.writeFile(path.join(dir, 'no-such-dir', 'x.txt'), 'data', (badErr) => {
          assert.ok(badErr, 'writing under a missing directory must error');
          assert.equal(typeof badErr.code, 'string');
          assert.ok(badErr.code.length > 0);
          assert.equal(typeof badErr.errno, 'number');
          fs.rmSync(dir, { recursive: true, force: true });
          console.log('ok');
        });
      });
    });
  });
});
