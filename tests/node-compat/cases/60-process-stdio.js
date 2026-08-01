// process.stdout / process.stderr — the shape node exposes, diffed against node.
//
// Node's `process.stdout` is polymorphic by fd type, which is the part a reimplementation
// gets wrong. Measured against node 24.18.1:
//
//   stdout ->  constructor        write(300KB)   isTTY      columns
//   file       SyncWriteStream    true           undefined  undefined
//   pipe       Socket             false          undefined  undefined
//   tty        WriteStream        true           true        <number>
//
// This case runs under the compat harness, which redirects both streams to files, so it
// pins the NON-TTY half. The TTY half needs a pty and is pinned Lava-only in
// cmd/lava/process_stdio_test.odin — node cannot be the oracle for it here because the
// harness has no terminal to give either runtime.
//
// `instanceof stream.Writable` is true for node in all three cases, which is why this is
// built on the real Writable rather than a lookalike: libraries feature-detect with it.
const assert = require('node:assert/strict');
const stream = require('node:stream');

const out = process.stdout;
const err = process.stderr;

// Identity and shape.
assert.equal(typeof out, 'object', 'process.stdout must exist');
assert.equal(typeof err, 'object', 'process.stderr must exist');
assert.equal(out, process.stdout, 'the getter must be stable, not build a new stream');
assert.equal(out.fd, 1);
assert.equal(err.fd, 2);
assert.ok(out instanceof stream.Writable, 'stdout must be a real Writable');
assert.ok(err instanceof stream.Writable, 'stderr must be a real Writable');
assert.equal(typeof out.write, 'function');
assert.equal(typeof out.end, 'function');
assert.equal(typeof out.on, 'function');
assert.equal(typeof out.once, 'function');
assert.equal(typeof out.emit, 'function');
assert.equal(typeof out.cork, 'function');

// Non-TTY: node reports undefined for all three, NOT false/80/24. A capability check
// written as `if (process.stdout.isTTY)` must see undefined, and `columns || 80` must
// fall through to the caller's default rather than to a fake terminal size.
assert.equal(out.isTTY, undefined, 'isTTY is undefined off a terminal, not false');
assert.equal(out.columns, undefined);
assert.equal(out.rows, undefined);

// Writable state.
assert.equal(out.writable, true);
assert.equal(out.writableEnded, false);
assert.equal(out.destroyed, false);

// Argument coercion: node rejects a number outright rather than stringifying it.
assert.throws(() => out.write(5), { code: 'ERR_INVALID_ARG_TYPE' });
// null is a DIFFERENT error from a wrong type — Writable checks it before the type
// check. Asserting ERR_INVALID_ARG_TYPE here was my guess; node says otherwise.
assert.throws(() => out.write(null), { code: 'ERR_STREAM_NULL_VALUES' });

// Accepted chunk types.
assert.equal(out.write(''), true);
assert.equal(out.write('', 'utf8'), true);
assert.equal(out.write(Buffer.alloc(0)), true);

// Ordering against console.log — they share the same fd and must not reorder. This is the
// assertion that catches a buffered implementation: anything that queues stdout writes
// while console.log stays synchronous prints these out of order.
process.stdout.write('A');
console.log('B');
process.stdout.write('C');
console.log('D');

// stderr is a separate stream and must not interleave into stdout's ordering above.
process.stderr.write('E1\n');

// The write callback runs, and asynchronously (node does not call it inline).
let cbRan = 'no';
process.stdout.write('F', () => {
  cbRan = 'yes';
});
assert.equal(cbRan, 'no', 'the write callback must not fire synchronously');

// The callback lands on a later turn. A timer rather than process.on('exit') because
// `process.on` does not exist in Lava yet — a separate gap, recorded in ROADMAP, and not
// something this case should smuggle in as a requirement.
setTimeout(() => {
  assert.equal(cbRan, 'yes', 'the write callback must eventually run');
  console.log('done');
}, 0);
