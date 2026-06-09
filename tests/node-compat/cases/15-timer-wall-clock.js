// Timers fire after real wall-clock time, not a logical clock that fast-forwards
// (issue #28). Pre-fix, Lava advanced a virtual clock while running to idle, so
// setTimeout(fn, N) fired immediately. This asserts a lower bound only: a loaded
// host makes the measured delay larger, never smaller, so it is not timing-flaky
// — it just rules out the instant (virtual-clock) fire. Node, which always honors
// real delays, passes it too, so node-vs-Lava output stays identical.
const assert = require('node:assert/strict');

const DELAY = 60;
const start = Date.now();

setTimeout(() => {
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= DELAY - 20, `timer fired too early: ${elapsed}ms (expected >= ${DELAY}ms)`);

  // A repeating timer's deadlines also elapse in real time across ticks.
  let ticks = 0;
  const intervalStart = Date.now();
  const id = setInterval(() => {
    if (++ticks === 2) {
      clearInterval(id);
      const span = Date.now() - intervalStart;
      assert.ok(span >= 2 * 20 - 20, `interval ran too fast: ${span}ms over 2 ticks`);
    }
  }, 20);
}, DELAY);
