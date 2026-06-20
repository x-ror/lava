// node:events static helpers — getEventListeners/getMaxListeners/setMaxListeners/
// listenerCount/addAbortListener and the events.on async iterator. node and lava must
// produce identical output.
const assert = require('node:assert/strict');
const events = require('node:events');
const {
  EventEmitter,
  on,
  getEventListeners,
  getMaxListeners,
  setMaxListeners,
  listenerCount,
  addAbortListener,
} = events;

(async () => {
  const ee = new EventEmitter();
  const f = () => {};
  ee.on('x', f);

  assert.deepEqual(getEventListeners(ee, 'x'), [f]);
  assert.equal(getMaxListeners(ee), 10);
  setMaxListeners(3, ee);
  assert.equal(ee.getMaxListeners(), 3);
  assert.equal(listenerCount(ee, 'x'), 1);
  assert.throws(() => setMaxListeners(-1), { code: 'ERR_OUT_OF_RANGE' });

  // setMaxListeners with no target sets the global default
  setMaxListeners(8);
  assert.equal(new EventEmitter().getMaxListeners(), 8);
  setMaxListeners(10);

  // addAbortListener fires its listener when the signal aborts
  const ac = new AbortController();
  let aborted = 0;
  addAbortListener(ac.signal, () => aborted++);
  ac.abort();
  assert.equal(aborted, 1);
  assert.throws(() => addAbortListener({}, () => {}), {
    code: 'ERR_INVALID_ARG_TYPE',
  });

  // events.on yields the args of each event until the iterator is closed
  const emitter = new EventEmitter();
  const it = on(emitter, 'data');
  (async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      emitter.emit('data', i, 'v' + i);
    }
    it.return();
  })();
  const got = [];
  for await (const args of it) got.push(args);
  assert.deepEqual(got, [
    [0, 'v0'],
    [1, 'v1'],
    [2, 'v2'],
  ]);

  console.log('ok');
})();
