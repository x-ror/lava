// node:diagnostics_channel and util.isDeepStrictEqual. node and lava must produce
// identical output.
const assert = require('node:assert/strict');
const dc = require('node:diagnostics_channel');
const util = require('node:util');

// --- diagnostics_channel core pub/sub ---
const ch = dc.channel('test:event');
assert.equal(ch, dc.channel('test:event')); // deduped
assert.equal(dc.hasSubscribers('test:event'), false);
let received = null;
const onMsg = (msg, name) => {
  received = [msg.v, name];
};
ch.subscribe(onMsg);
assert.equal(ch.hasSubscribers, true);
assert.equal(dc.hasSubscribers('test:event'), true);
ch.publish({ v: 42 });
assert.deepEqual(received, [42, 'test:event']);
assert.equal(ch.unsubscribe(onMsg), true);
assert.equal(ch.unsubscribe(onMsg), false);
assert.equal(ch.hasSubscribers, false);

// --- tracingChannel traceSync event ordering ---
const tc = dc.tracingChannel('op');
const order = [];
tc.subscribe({
  start: (c) => order.push('start:' + c.id),
  end: (c) => order.push('end:' + c.result),
  error: (c) => order.push('error:' + c.error.message),
});
assert.equal(
  tc.traceSync((a, b) => a + b, { id: 1 }, null, 2, 3),
  5,
);
assert.throws(() =>
  tc.traceSync(
    () => {
      throw new Error('boom');
    },
    { id: 2 },
    null,
  ),
);
assert.deepEqual(order, ['start:1', 'end:5', 'start:2', 'error:boom', 'end:undefined']);

// --- util.isDeepStrictEqual ---
assert.equal(
  util.isDeepStrictEqual({ a: [1, 2], d: new Date(0) }, { a: [1, 2], d: new Date(0) }),
  true,
);
assert.equal(util.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
assert.equal(util.isDeepStrictEqual(NaN, NaN), true);
assert.equal(util.isDeepStrictEqual(0, -0), false);
assert.equal(util.isDeepStrictEqual(new Map([[1, 'a']]), new Map([[1, 'a']])), true);
assert.equal(util.isDeepStrictEqual(new Set([1, 2]), new Set([2, 1])), true);
assert.equal(util.isDeepStrictEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
assert.equal(util.isDeepStrictEqual(/a/gi, /a/gi), true);

console.log('ok');
