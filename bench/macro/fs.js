'use strict';

// Macro fs throughput: write then read back a 64 KiB payload with the synchronous APIs,
// repeatedly, in a temp dir. This is genuinely I/O-bound, so the node-vs-lava ratio
// reflects the native fs path (and, once §5.2 step 2 lands, will be the regression guard
// for moving reads onto the thread pool). Sync APIs stay on the loop thread in both
// runtimes, so the comparison is apples-to-apples today.
const { bench } = require('../lib/harness');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lava-bench-fs-'));
const file = path.join(dir, 'payload.bin');
const payload = Buffer.alloc(64 * 1024, 0x61);

// The ENCODED read is a separate arm on purpose. `fs-write-read-64k` above only ever
// takes the binary path, so when #330 moved decoding out of the native and into Buffer's
// codecs it measured 0.987 — a clean bill of health for a path that had barely changed —
// while `readFileSync(p, 'utf8')` regressed 2.72x at 100 KB with nothing to catch it.
// Two sizes because the cost splits: the small one is dominated by the extra crossing and
// the Buffer wrapper, the large one by the second pass over the bytes.
const textFile = path.join(dir, 'payload.txt');
fs.writeFileSync(textFile, 'a'.repeat(1024));
const bigTextFile = path.join(dir, 'payload-64k.txt');
fs.writeFileSync(bigTextFile, 'a'.repeat(64 * 1024));

try {
  bench(
    'fs-write-read-64k',
    () => {
      fs.writeFileSync(file, payload);
      return fs.readFileSync(file).length;
    },
    { iterations: 500, warmup: 10, reps: 3 },
  );
  bench('fs-read-utf8-1k', () => fs.readFileSync(textFile, 'utf8').length, {
    iterations: 2000,
    warmup: 50,
    reps: 3,
  });
  bench('fs-read-utf8-64k', () => fs.readFileSync(bigTextFile, 'utf8').length, {
    iterations: 500,
    warmup: 10,
    reps: 3,
  });
  bench('fs-read-bin-1k', () => fs.readFileSync(textFile).length, {
    iterations: 2000,
    warmup: 50,
    reps: 3,
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
