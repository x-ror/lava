// Node-parity fixes from issue #110: abort listener isolation, AbortSignal.any
// cleanup, fileURLToPath validation, timers/promises setInterval buffering.
'use strict';
const assert = require('node:assert/strict');
const url = require('node:url');
const tp = require('node:timers/promises');

async function main() {
  // --- AbortSignal.any: combined fires when any source fires ---
  {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const combined = AbortSignal.any([ac1.signal, ac2.signal]);
    assert.equal(combined.aborted, false);
    ac1.abort();
    assert.equal(combined.aborted, true);
    // After combined fires, aborting ac2 must not throw (no double-listener issues)
    ac2.abort();
  }

  // --- AbortSignal.any: pre-aborted source ---
  {
    const combined = AbortSignal.any([AbortSignal.abort()]);
    assert.equal(combined.aborted, true);
  }

  // --- AbortSignal.any: input validation ---
  {
    assert.throws(() => AbortSignal.any(null), TypeError);
    assert.throws(() => AbortSignal.any(42), TypeError);
  }

  // --- fileURLToPath: encoded path separator rejected ---
  {
    assert.throws(
      () => url.fileURLToPath('file:///foo%2Fbar'),
      (e) => e.code === 'ERR_INVALID_FILE_URL_PATH',
      'encoded / in path must throw ERR_INVALID_FILE_URL_PATH',
    );
  }

  // --- fileURLToPath: non-localhost host rejected ---
  {
    assert.throws(
      () => url.fileURLToPath('file://evil.com/x'),
      (e) => e.code === 'ERR_INVALID_FILE_URL_HOST',
      'non-localhost host must throw ERR_INVALID_FILE_URL_HOST',
    );
  }

  // --- fileURLToPath: localhost and empty host accepted ---
  {
    assert.equal(url.fileURLToPath('file:///foo/bar'), '/foo/bar');
    assert.equal(url.fileURLToPath('file://localhost/foo/bar'), '/foo/bar');
  }

  // --- timers/promises setInterval: no hang after break ---
  {
    let count = 0;
    for await (const _ of tp.setInterval(5, 'x')) {
      count++;
      if (count >= 3) break;
    }
    assert.equal(count, 3, 'setInterval must yield exactly 3 times before break');
  }

  // --- timers/promises setInterval: abort via signal ---
  {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let ticks = 0;
    let threw = false;
    try {
      for await (const _ of tp.setInterval(10, 'y', { signal: ac.signal })) {
        ticks++;
      }
    } catch (e) {
      threw = true;
      assert.equal(e.name, 'AbortError');
    }
    assert.ok(threw, 'setInterval must throw AbortError when signal fires');
    assert.ok(ticks >= 1, 'setInterval must yield at least once before abort');
  }

  console.log('internals-parity ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
