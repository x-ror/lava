const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');

async function main() {
  const emitter = new EventEmitter();
  const seen = [];

  emitter.on('ready', (value) => {
    seen.push(value);
  });

  emitter.emit('ready', 41);
  emitter.emit('ready', 42);

  assert.deepEqual(seen, [41, 42]);

  const oncePromise = once(emitter, 'done');
  emitter.emit('done', 'ok');
  const [value] = await oncePromise;

  assert.equal(value, 'ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
