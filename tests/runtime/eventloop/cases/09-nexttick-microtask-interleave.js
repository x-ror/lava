const assert = require('node:assert/strict');

// Companion to 01-nexttick-and-microtasks: locks in nextTick/microtask ordering
// relative to JSC's promise-job queue. Each scenario runs at a fresh macrotask
// boundary (the top of a setTimeout callback, where Node drains the nextTick
// queue ahead of microtasks), then resolves after a following macrotask so every
// microtask/nextTick has drained before the assertion.
function scenario(body) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const ev = [];
      body(ev);
      setTimeout(() => resolve(ev), 0);
    }, 0);
  });
}

(async () => {
  // nextTick (including nested) drains fully, ahead of promise jobs and
  // queueMicrotask callbacks queued in the same turn.
  assert.deepEqual(
    await scenario((ev) => {
      process.nextTick(() => {
        ev.push('nt1');
        process.nextTick(() => ev.push('nt2'));
      });
      Promise.resolve().then(() => ev.push('p'));
      queueMicrotask(() => ev.push('qm'));
    }),
    ['nt1', 'nt2', 'p', 'qm'],
  );

  // A nextTick queued from within a promise job runs after the microtask queue
  // drains, not immediately after the job that queued it.
  assert.deepEqual(
    await scenario((ev) => {
      Promise.resolve().then(() => {
        ev.push('p1');
        process.nextTick(() => ev.push('nt-in-p1'));
      });
      Promise.resolve().then(() => ev.push('p2'));
    }),
    ['p1', 'p2', 'nt-in-p1'],
  );

  // queueMicrotask shares one FIFO queue with promise jobs.
  assert.deepEqual(
    await scenario((ev) => {
      queueMicrotask(() => ev.push('qm1'));
      Promise.resolve().then(() => ev.push('p1'));
      queueMicrotask(() => ev.push('qm2'));
      Promise.resolve().then(() => ev.push('p2'));
    }),
    ['qm1', 'p1', 'qm2', 'p2'],
  );

  // process.nextTick forwards trailing arguments to the callback (Node parity).
  assert.deepEqual(
    await scenario((ev) => {
      process.nextTick((a, b) => ev.push(a + b), 'x', 'y');
    }),
    ['xy'],
  );
})();
