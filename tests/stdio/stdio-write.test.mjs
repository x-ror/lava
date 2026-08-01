// stdout/stderr must not drop bytes on a NON-BLOCKING fd.
//
// This is a node:test rather than an oracle case because the condition cannot be set up
// from inside the script under test: it needs the PARENT to hand the child a pipe with
// O_NONBLOCK already set. That is not exotic — a process manager, an editor's task
// runner or a CI harness can all do it, and the child inherits it.
//
// What made it invisible: with an ordinary shell pipe (blocking) a 1 MB write is
// delivered intact, so every casual check passes. Only the non-blocking case loses data,
// and it loses it SILENTLY — the process exits 0 having written a fraction of the bytes.
//
// Measured before the fix, `console.log('x'.repeat(300000))`:
//   node  exit=0  300001 bytes
//   lava  exit=0   65536 bytes   (one pipe buffer; 234 465 bytes gone)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAVA = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const DIR = mkdtempSync(join(tmpdir(), 'lava-stdio-'));

// Drive the child through a pipe whose write end is non-blocking. node's own child_process
// gives us a blocking pipe, so the flag is set on the fd we hand over.
function runWithNonBlockingStdout(script, bytes, argv) {
  return new Promise((resolve, reject) => {
    let args = argv;
    if (!args) {
      const file = join(DIR, `w-${bytes}-${Math.abs(hash(script))}.js`);
      writeFileSync(file, script);
      args = ['run', file];
    }
    // `stdbuf`-free approach: a python shim owns the pipe so it can set O_NONBLOCK, then
    // reads everything back. Keeping the shim inline avoids a second fixture file.
    const shim = `
import os, subprocess, sys, time, select, hashlib
r, w = os.pipe()
os.set_blocking(w, False)
p = subprocess.Popen(sys.argv[1:], stdout=w, stderr=subprocess.DEVNULL)
os.close(w)
os.set_blocking(r, True)
# Do NOT drain while the child writes. An earlier version read in a tight loop, which kept
# the pipe empty, so EAGAIN never fired and the buggy build delivered every byte — the test
# passed against the very mutation it was recorded to kill. Sleeping first guarantees the
# pipe fills and the retry path is the only way through.
time.sleep(1.0)
got = 0
h = hashlib.sha256()
while True:
    rl, _, _ = select.select([r], [], [], 20)
    if not rl:
        print("TIMEOUT"); os.close(r); p.kill(); sys.exit(0)
    chunk = os.read(r, 65536)
    if not chunk: break
    got += len(chunk); h.update(chunk)
os.close(r)
try:
    p.wait(timeout=20)
except subprocess.TimeoutExpired:
    p.kill(); print("TIMEOUT"); sys.exit(0)
print(f"{p.returncode} {got} {h.hexdigest()}")
`;
    const child = spawn('python3', ['-c', shim, LAVA, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () => {
      const text = out.trim();
      // Reject rather than resolve with undefined: `''.split().map(Number)` used to yield
      // [0], so a harness failure surfaced as code=0/got=undefined and the notEqual
      // assertion below passed on it.
      if (text === 'TIMEOUT') return reject(new Error('child hung: shim timed out'));
      const m = /^(\d+) (\d+) ([0-9a-f]{64})$/.exec(text);
      if (!m) return reject(new Error(`shim produced no usable result: ${JSON.stringify(text)}`));
      resolve({ code: Number(m[1]), got: Number(m[2]), sha: m[3] });
    });
  });
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// 300 000 is comfortably past a 64 KiB pipe buffer, so the first write cannot complete in
// one syscall and the retry path is forced.
const BIG = 300000;

test('console.log delivers every byte on a non-blocking stdout', async () => {
  const { code, got } = await runWithNonBlockingStdout(`console.log('x'.repeat(${BIG}));\n`, BIG);
  assert.equal(code, 0, 'child should exit cleanly');
  assert.equal(got, BIG + 1, `expected ${BIG + 1} bytes (payload + newline), got ${got}`);
});

test('the delivered bytes are the right bytes in the right order', async () => {
  // Not a byte COUNT check: this pins `rest = rest[n:]` against a re-slice that duplicates
  // or skips a span, which a count alone cannot see. The previous version of this case
  // asserted `notEqual(got, 65536)`, which passed vacuously whenever the harness failed
  // (got was undefined) and hardcoded Linux's default pipe capacity besides.
  const { code, got, sha } = await runWithNonBlockingStdout(
    `console.log('y'.repeat(${BIG}));\n`,
    BIG,
  );
  assert.equal(code, 0);
  assert.equal(got, BIG + 1);
  const expected = createHash('sha256')
    .update('y'.repeat(BIG) + '\n')
    .digest('hex');
  assert.equal(sha, expected, 'payload must round-trip exactly');
});

// The CLI's own writers, which are a different path from console.log: `lava eval` prints
// through print_result, not through the JS console binding. It truncated identically and
// was missed by the first version of this fix.
test('lava eval prints its whole result on a non-blocking stdout', async () => {
  const { code, got } = await runWithNonBlockingStdout(null, BIG, ['eval', `'x'.repeat(${BIG})`]);
  assert.equal(code, 0);
  assert.equal(got, BIG + 1);
});

test('many small writes on a non-blocking stdout are all delivered', async () => {
  // A different shape of the same failure: no single write exceeds the buffer, but the
  // total does, so the drop appears only once the pipe fills.
  const n = 20000;
  const line = 'abcdefghij';
  const { code, got } = await runWithNonBlockingStdout(
    `for (let i = 0; i < ${n}; i++) console.log('${line}');\n`,
    n,
  );
  assert.equal(code, 0);
  assert.equal(got, n * (line.length + 1), `expected ${n * (line.length + 1)} bytes, got ${got}`);
});
