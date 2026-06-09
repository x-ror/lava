const assert = require('node:assert/strict');

(async () => {
  const events = [];

  Promise.resolve().then(() => events.push('promise'));
  queueMicrotask(() => events.push('microtask'));

  await new Promise((resolve) => {
    setTimeout(() => {
      events.push('timer');
      resolve();
    }, 0);
  });

  assert.deepEqual(events, ['promise', 'microtask', 'timer']);
})();
