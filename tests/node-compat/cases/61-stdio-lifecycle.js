// `src.pipe(process.stdout)` must leave stdout alive.
//
// Node excludes the stdio singletons from pipe()'s automatic `dest.end()`:
//   doEnd = (!opts || opts.end !== false) && dest !== process.stdout && dest !== process.stderr
// Without it the most common pipe in Node ends a process-lifetime singleton — every later
// write on stdout is dropped, 'write after end' is raised, and the exit code goes 0 -> 1.
//
// SHAPE-INDEPENDENCE IS LOAD-BEARING HERE, and it is why this case asserts less than it
// first did. `process.stdout` is polymorphic in node — a SyncWriteStream on a file, a
// net.Socket on a pipe — and the two disagree about the rest of the lifecycle:
//
//   write('A'); end('B'); <tick>; write('C')   node stdout   node exit
//   stdout redirected to a file                A B C         0
//   stdout on a pipe                           A B           1  (EPIPE, half-closed)
//
// So `end()`/`destroy()` recovery is NOT assertable from inside an oracle case: it holds
// under scripts/lib/compare.sh, which redirects to a file, and fails under any harness
// that captures through a pipe — the mutation runner does exactly that, and caught this
// case asserting a file-only truth. Those assertions live in
// tests/stdio/stdio-lifecycle.test.mjs instead, which sets the shape itself and pins both.
//
// The pipe exclusion below is the part that is true in every shape, verified under both.
//
// Everything is written through `process.stdout.write` rather than console.log, because
// Lava's console bypasses the stream through a native binding — a dead stream would still
// print, and the case would pass while stdout was broken.
const assert = require('node:assert/strict');
const stream = require('node:stream');

const out = process.stdout;

// node marks both singletons with an own `_isStdio`; its own stream/net code
// feature-detects on it, so ecosystem code reads it too.
assert.equal(out._isStdio, true, 'stdout must carry node’s _isStdio marker');
assert.equal(process.stderr._isStdio, true, 'stderr must carry it too');
assert.equal(
  Object.prototype.hasOwnProperty.call(out, '_isStdio'),
  true,
  '_isStdio must be an own property, as it is on node',
);
// The mechanism behind the recovery pinned in tests/stdio/stdio-lifecycle.test.mjs. Node
// exposes it on Writable, Readable and process.stdout alike.
assert.equal(typeof out._undestroy, 'function', 'Writable must expose _undestroy');
assert.equal(typeof new stream.Readable({ read() {} })._undestroy, 'function');

// The EVENT COUNT is what pins the pipe exclusion, and the state assertions below are
// not enough on their own — which is only true because of the other half of this fix.
// Once `_destroy` undoes the teardown, a pipe that wrongly calls `end()` no longer leaves
// stdout dead: 'finish' fires, autoDestroy runs `_destroy`, and the stream is writable
// again a tick later. So `out.writable` reads true either way, and the only surviving
// evidence that end() was reached at all is that it emitted. Verified by mutation —
// deleting the exclusion fails on `finishes`, not on any of the state checks.
const finishes = [];
out.on('finish', () => finishes.push(1));

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function pipeOnce(text) {
  const src = new stream.Readable({ read() {} });
  src.push(text);
  src.push(null);
  src.pipe(out);
  return new Promise((resolve) => src.on('end', resolve));
}

async function main() {
  await pipeOnce('one\n');
  await tick();

  assert.equal(out.writable, true, 'pipe() must not end stdout');
  assert.equal(out.writableEnded, false, 'pipe() must not mark stdout ended');
  assert.equal(out.writableFinished, false, 'pipe() must not finish stdout');
  assert.equal(out.destroyed, false, 'pipe() must not destroy stdout');
  assert.equal(finishes.length, 0, 'pipe() must not even reach end(), so no finish');
  assert.equal(out.write('two\n'), true, 'stdout must still accept writes after a pipe');

  // Twice, because a stream that survived one pipe can still have been left in a state
  // that breaks the next one.
  await pipeOnce('three\n');
  await tick();
  assert.equal(out.writable, true, 'stdout must survive a second pipe');
  assert.equal(finishes.length, 0, 'still no finish after the second pipe');
  out.write('four\n');
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
