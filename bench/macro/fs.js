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

try {
  bench(
    'fs-write-read-64k',
    () => {
      fs.writeFileSync(file, payload);
      return fs.readFileSync(file).length;
    },
    { iterations: 500, warmup: 10, reps: 3 },
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
