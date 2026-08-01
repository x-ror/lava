// process.stdout / process.stderr must survive being ended.
//
// Node deliberately makes the stdio singletons unkillable, by two separate mechanisms
// that this case pins together because either one alone still leaves stdout dead:
//
//   1. `Readable.prototype.pipe` excludes them from the automatic `dest.end()`:
//      `doEnd = (!opts || opts.end !== false) && dest !== process.stdout &&
//       dest !== process.stderr`. Without it, the single most common idiom in Node —
//      `src.pipe(process.stdout)` — ends stdout for the rest of the process.
//   2. `_destroy` is a dummy that runs the callback and then calls `this._undestroy()`,
//      so an explicit `end()`/`destroy()` still emits 'finish'/'close' and still runs the
//      end callback, but the stream is writable again on the next tick.
//
// Measured on node 24.18.1 — `process.stdout.end()`, then one tick:
//
//   after end(), same tick   writable=false ended=true  finished=false destroyed=false
//   events                   end-cb, 'finish', 'close'
//   after one tick           writable=true  ended=false finished=false destroyed=false
//   next write()             true, and the bytes land
//
// The recovery is what matters: `end()` is not a no-op there (the events all fire), it is
// undone. A shim that stubbed `end` to do nothing would pass the state assertions below
// and fail the event ones, which is why both are here.
//
// Everything is written through `process.stdout.write` rather than console.log, because
// Lava's console bypasses the stream through a native binding — a dead stream would still
// print, and the case would pass while stdout was broken.
const assert = require('node:assert/strict');
const stream = require('node:stream');

const out = process.stdout;

// node marks both singletons with an own `_isStdio`; it is what the rest of node's
// stream/net code feature-detects on, so libraries read it too.
assert.equal(out._isStdio, true, 'stdout must carry node’s _isStdio marker');
assert.equal(process.stderr._isStdio, true, 'stderr must carry it too');
assert.equal(
  Object.prototype.hasOwnProperty.call(out, '_isStdio'),
  true,
  '_isStdio must be an own property, as it is on node',
);
assert.equal(typeof out._undestroy, 'function', 'Writable must expose _undestroy');

const finishes = [];
const closes = [];
out.on('finish', () => finishes.push(1));
out.on('close', () => closes.push(1));

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function main() {
  // --- 1. pipe(process.stdout) must leave stdout alive ------------------------------
  const src = new stream.Readable({ read() {} });
  src.push('one\n');
  src.push(null);
  src.pipe(out);
  await new Promise((resolve) => src.on('end', resolve));
  await tick();

  assert.equal(out.writable, true, 'pipe() must not end stdout');
  assert.equal(out.writableEnded, false, 'pipe() must not mark stdout ended');
  assert.equal(out.destroyed, false, 'pipe() must not destroy stdout');
  assert.equal(finishes.length, 0, 'pipe() must not even reach end(), so no finish');
  assert.equal(out.write('two\n'), true, 'stdout must still accept writes after a pipe');

  // --- 2. an explicit end() runs, then undoes itself --------------------------------
  let endCb = 0;
  out.end('three\n', () => {
    endCb++;
  });
  // Same tick: node reports the stream as ended before the recovery lands.
  assert.equal(out.writable, false, 'end() is not a no-op: it takes effect first');
  assert.equal(out.writableEnded, true, 'end() marks the stream ended first');

  await tick();
  assert.equal(endCb, 1, 'the end callback must still run');
  assert.equal(finishes.length, 1, "end() must still emit 'finish'");
  assert.equal(closes.length, 1, "end() must still emit 'close'");
  assert.equal(out.writable, true, 'stdout must be writable again after end()');
  assert.equal(out.writableEnded, false, 'the ended flag must be undone');
  assert.equal(out.writableFinished, false, 'the finished flag must be undone');
  assert.equal(out.destroyed, false, 'stdout must not stay destroyed');
  assert.equal(out.write('four\n'), true, 'writes must work again after end()');

  // --- 3. an explicit destroy() likewise --------------------------------------------
  out.destroy();
  await tick();
  assert.equal(out.destroyed, false, 'stdout must not stay destroyed after destroy()');
  assert.equal(out.writable, true, 'stdout must be writable again after destroy()');
  assert.equal(closes.length, 2, "destroy() must still emit 'close'");
  assert.equal(out.write('five\n'), true, 'writes must work again after destroy()');

  // --- 4. and a second pipe still works ---------------------------------------------
  const src2 = new stream.Readable({ read() {} });
  src2.push('six\n');
  src2.push(null);
  src2.pipe(out);
  await new Promise((resolve) => src2.on('end', resolve));
  await tick();
  assert.equal(out.writable, true, 'stdout must survive a pipe after an end()/destroy()');
  out.write('seven\n');
}

main().then(
  () => {},
  (err) => {
    // Surface the failure on stdout so the oracle diff shows the reason rather than an
    // empty stream: an assertion that throws here would otherwise only change the exit
    // code, and the harness compares bytes.
    process.stdout.write('FAILED: ' + err.message + '\n');
    process.exitCode = 1;
  },
);
