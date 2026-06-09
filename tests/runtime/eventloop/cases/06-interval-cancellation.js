const assert = require('node:assert/strict');

(async () => {
  const events = [];

  const interval = setInterval(() => {
    events.push('tick');
    if (events.length === 2) {
      clearInterval(interval);
    }
  }, 0);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events, ['tick', 'tick']);
})();
