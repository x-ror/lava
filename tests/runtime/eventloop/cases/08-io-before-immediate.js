const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const events = [];
  const fixture = path.join(__dirname, '..', '..', '..', 'node-compat', 'fixtures', 'hello.txt');

  await new Promise((resolve, reject) => {
    fs.readFile(fixture, 'utf8', (error) => {
      if (error) {
        reject(error);
        return;
      }

      events.push('io');
      setImmediate(() => {
        events.push('immediate');
        resolve();
      });
    });
  });

  assert.deepEqual(events, ['io', 'immediate']);
})();
