/**
 * The lock exists because the dispatch ledger is a read-modify-write of one
 * whole file, and two pollers can interleave load and save.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { withLock } from './lock.mjs';
import { ROOT } from './paths.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'lava-lock-'));
}

test('the critical section runs and the lock is released', () => {
  const dir = scratch();
  try {
    assert.equal(
      withLock('t', () => 42, { dir }),
      42,
    );
    assert.equal(existsSync(join(dir, 't.lock')), false, 'lock survived a clean exit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a throwing section still releases the lock', () => {
  const dir = scratch();
  try {
    assert.throws(
      () =>
        withLock(
          't',
          () => {
            throw new Error('boom');
          },
          { dir },
        ),
      /boom/,
    );
    assert.equal(existsSync(join(dir, 't.lock')), false, 'a throw wedged the lock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a held lock blocks rather than letting both sections run', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 't.lock'));
    assert.throws(
      () => withLock('t', () => 'entered', { dir, timeoutMs: 200, staleMs: 60_000 }),
      /timed out/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock is broken so a killed holder cannot wedge the queue forever', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 't.lock'));
    assert.equal(
      withLock('t', () => 'entered', { dir, staleMs: 0, timeoutMs: 500 }),
      'entered',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processes racing the same counter lose no increment', async () => {
  // The real shape of the bug: load, edit, save from several processes at once.
  // Without the lock a save overwrites an increment another process just made.
  //
  // The children must run CONCURRENTLY. The first version of this used
  // execFileSync in a .map(), which blocks — the three ran one after another,
  // there was never any contention, and the test passed just as happily with
  // the lock replaced by a passthrough.
  const dir = scratch();
  const file = join(dir, 'counter.json');
  writeFileSync(file, JSON.stringify({ n: 0 }));
  const worker = join(dir, 'worker.mjs');
  writeFileSync(
    worker,
    `import { readFileSync, writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(join(ROOT, 'runtime/lock.mjs'))};
const dir = ${JSON.stringify(dir)};
const file = ${JSON.stringify(file)};
for (let i = 0; i < 25; i++) {
  withLock('counter', () => {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    // Widen the window the lock has to cover.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    writeFileSync(file, JSON.stringify({ n: s.n + 1 }));
  }, { dir, timeoutMs: 20000 });
}
`,
  );
  try {
    const codes = await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise((resolve, reject) => {
            const p = spawn(process.execPath, [worker], { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = '';
            p.stderr.on('data', (d) => (err += d));
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(err))));
          }),
      ),
    );
    assert.deepEqual(codes, [0, 0, 0]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).n, 75, 'an increment was lost');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
