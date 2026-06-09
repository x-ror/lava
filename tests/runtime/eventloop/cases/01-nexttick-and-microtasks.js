const assert = require('node:assert/strict');

(async () => {
  const events = [];

  process.nextTick(() => events.push('nextTick'));
  Promise.resolve().then(() => events.push('promise'));
  queueMicrotask(() => events.push('queueMicrotask'));

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, ['nextTick', 'promise', 'queueMicrotask']);
})();
