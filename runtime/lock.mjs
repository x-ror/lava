/**
 * Cross-process lock for the shared files under `.agent-state/`.
 *
 * The dispatch ledger is a read-modify-write of one whole JSON file. Two pollers
 * — a cron tick and a terminal, or two terminals draining disjoint issue lists,
 * which USAGE.md explicitly suggests — can interleave load and save and lose an
 * attempt count or a completion. `saveState`'s tmp+rename makes each write
 * atomic, which is not the same as making the read-modify-write atomic.
 *
 * `mkdir` is the primitive: it is atomic on POSIX and on Windows, needs no
 * dependency, and leaves a directory whose mtime dates the holder — so a lock
 * left behind by a killed process can be told from one in active use.
 *
 * Critical sections here are milliseconds (parse, edit, write). Anything that
 * runs an agent belongs OUTSIDE the lock.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './paths.mjs';

/** A holder that has not finished in this long has died mid-section. */
const STALE_MS = 60_000;
/** Give up rather than block a cron tick forever. */
const TIMEOUT_MS = 30_000;

function sleep(ms) {
  // Synchronous by necessity: the callers are sync read-modify-write paths.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` with an exclusive lock named `name`.
 *
 * @template T
 * @param {string} name lock identity, e.g. 'trigger-issues-seen'
 * @param {() => T} fn critical section; keep it short
 * @param {{ staleMs?: number, timeoutMs?: number, dir?: string }} [opts]
 * @returns {T}
 * @throws {Error} when the lock cannot be taken within the timeout.
 */
export function withLock(name, fn, opts = {}) {
  const dir = opts.dir || STATE_DIR;
  const staleMs = opts.staleMs ?? STALE_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const lockPath = join(dir, `${name}.lock`);
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the failed mkdir and the stat — retry
      }
      if (age > staleMs) {
        // Breaking a stale lock can race another breaker; both then re-attempt
        // mkdir and exactly one wins, so the outcome stays exclusive.
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath}`);
      }
      sleep(25);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
