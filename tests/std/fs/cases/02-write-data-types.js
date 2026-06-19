// fs.writeFile / writeFileSync data-type handling: DataView and offset typed-array
// windows write their viewed bytes (not the whole backing), and a bare ArrayBuffer is
// rejected with ERR_INVALID_ARG_TYPE — matching Node. Covers both the sync path and the
// pool-backed async path. node and lava must produce identical output.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-fs-write-types-'));
const file = path.join(dir, 'out.bin');

// DataView (sync): writes only the viewed window [3,4,5,6] of the 1..8 backing buffer.
const ab = new ArrayBuffer(8);
const fill = new Uint8Array(ab);
for (let i = 0; i < 8; i++) fill[i] = i + 1;
fs.writeFileSync(file, new DataView(ab, 2, 4));
assert.deepEqual([...fs.readFileSync(file)], [3, 4, 5, 6]);

// Offset typed-array (Buffer.subarray-style): writes the window, not the whole backing.
const big = Uint8Array.from([10, 20, 30, 40, 50]);
fs.writeFileSync(file, big.subarray(1, 4));
assert.deepEqual([...fs.readFileSync(file)], [20, 30, 40]);

// A bare ArrayBuffer is not a valid payload: both the sync and async forms throw
// ERR_INVALID_ARG_TYPE synchronously (the async form validates before scheduling).
assert.throws(() => fs.writeFileSync(file, new ArrayBuffer(4)), {
  code: 'ERR_INVALID_ARG_TYPE',
});
assert.throws(() => fs.writeFile(file, new ArrayBuffer(4), () => {}), {
  code: 'ERR_INVALID_ARG_TYPE',
});

// DataView (async): round-trips its window [7,8,9] through the worker pool.
const src = Uint8Array.from([0, 0, 7, 8, 9, 0]);
fs.writeFile(file, new DataView(src.buffer, 2, 3), (err) => {
  assert.equal(err, null);
  assert.deepEqual([...fs.readFileSync(file)], [7, 8, 9]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok');
});
