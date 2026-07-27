// node:stream core semantics, diffed against Node: Readable flow ('data'/'end'
// ordering), pause/resume backpressure, read(n) slicing, setEncoding, Writable
// HWM + 'drain' + 'finish', write-after-end error code, Transform/PassThrough
// through pipe(), pipeline() and finished(), async iteration, Readable.from,
// and objectMode. Async case: ends with main().catch(...) per suite convention.
const assert = require('node:assert/strict');
const {
  Readable,
  Writable,
  Duplex,
  Transform,
  PassThrough,
  pipeline,
  finished,
} = require('node:stream');
const streamPromises = require('node:stream/promises');

async function testFlowing() {
  const log = [];
  const r = new Readable({
    read() {
      this.push('a');
      this.push('b');
      this.push(null);
    },
  });
  r.setEncoding('utf8');
  r.on('data', (c) => log.push('data:' + c));
  await new Promise((resolve) => r.on('end', () => resolve()));
  log.push('end');
  assert.deepEqual(log, ['data:a', 'data:b', 'end']);
  console.log('flowing ok');
}

async function testPauseResume() {
  const log = [];
  const r = Readable.from(['x', 'y', 'z']);
  r.on('data', (c) => {
    log.push('data:' + c);
    if (c === 'x') {
      r.pause();
      setTimeout(() => {
        log.push('resume');
        r.resume();
      }, 5);
    }
  });
  await new Promise((resolve) => r.on('end', resolve));
  assert.deepEqual(log, ['data:x', 'resume', 'data:y', 'data:z']);
  console.log('pause/resume ok');
}

async function testReadN() {
  const r = new Readable({ read() {} });
  r.push(Buffer.from('hello world'));
  r.push(null);
  await new Promise((resolve) => r.once('readable', resolve));
  const first = r.read(5);
  assert.equal(first.toString(), 'hello');
  const rest = r.read();
  assert.equal(rest.toString(), ' world');
  assert.equal(r.read(), null);
  console.log('read(n) ok');
}

async function testWritableDrain() {
  const log = [];
  const chunks = [];
  const w = new Writable({
    highWaterMark: 4,
    write(chunk, enc, cb) {
      chunks.push(chunk.toString());
      setTimeout(cb, 1);
    },
  });
  const ok1 = w.write('aa');
  const ok2 = w.write('bbbb'); // exceeds HWM -> false
  log.push('ok1:' + ok1, 'ok2:' + ok2);
  await new Promise((resolve) => w.once('drain', resolve));
  log.push('drain');
  w.end('cc');
  await new Promise((resolve) => w.once('finish', resolve));
  log.push('finish');
  assert.deepEqual(chunks, ['aa', 'bbbb', 'cc']);
  assert.deepEqual(log, ['ok1:true', 'ok2:false', 'drain', 'finish']);
  console.log('writable drain/finish ok');
}

async function testWriteAfterEnd() {
  const w = new Writable({
    write(chunk, enc, cb) {
      cb();
    },
  });
  w.end();
  const err = await new Promise((resolve) => {
    w.on('error', resolve);
    w.write('nope', () => {});
  });
  assert.equal(err.code, 'ERR_STREAM_WRITE_AFTER_END');
  console.log('write-after-end ok');
}

async function testTransformPipe() {
  const out = [];
  const upper = new Transform({
    transform(chunk, enc, cb) {
      cb(null, chunk.toString().toUpperCase());
    },
  });
  const sink = new Writable({
    write(chunk, enc, cb) {
      out.push(chunk.toString());
      cb();
    },
  });
  Readable.from(['ab', 'cd']).pipe(upper).pipe(sink);
  await new Promise((resolve) => sink.on('finish', resolve));
  assert.deepEqual(out, ['AB', 'CD']);
  console.log('transform pipe ok');
}

async function testPassThroughBackpressure() {
  // A tiny-HWM PassThrough between a fast producer and a slow sink must not
  // lose or reorder chunks.
  const out = [];
  const pt = new PassThrough({ highWaterMark: 2 });
  const slow = new Writable({
    highWaterMark: 2,
    write(chunk, enc, cb) {
      out.push(chunk.toString());
      setTimeout(cb, 1);
    },
  });
  const src = Readable.from(['1', '2', '3', '4', '5']);
  src.pipe(pt).pipe(slow);
  await new Promise((resolve) => slow.on('finish', resolve));
  assert.deepEqual(out, ['1', '2', '3', '4', '5']);
  console.log('passthrough backpressure ok');
}

async function testPipeline() {
  const out = [];
  await streamPromises.pipeline(
    Readable.from(['a', 'b']),
    new Transform({
      transform(chunk, enc, cb) {
        cb(null, chunk.toString() + '!');
      },
    }),
    new Writable({
      write(chunk, enc, cb) {
        out.push(chunk.toString());
        cb();
      },
    }),
  );
  assert.deepEqual(out, ['a!', 'b!']);
  console.log('pipeline ok');
}

async function testPipelineError() {
  const err = await streamPromises
    .pipeline(
      new Readable({
        read() {
          this.destroy(new Error('src-boom'));
        },
      }),
      new PassThrough(),
    )
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(err, 'pipeline must reject');
  assert.equal(err.message, 'src-boom');
  console.log('pipeline error ok');
}

async function testAsyncIteration() {
  const seen = [];
  for await (const chunk of Readable.from([1, 2, 3])) seen.push(chunk);
  assert.deepEqual(seen, [1, 2, 3]);
  console.log('async iteration ok');
}

async function testObjectMode() {
  const seen = [];
  const w = new Writable({
    objectMode: true,
    write(obj, enc, cb) {
      seen.push(obj);
      cb();
    },
  });
  const r = Readable.from([{ a: 1 }, { b: 2 }]);
  r.pipe(w);
  await new Promise((resolve) => w.on('finish', resolve));
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
  console.log('objectMode ok');
}

async function testFinishedHelper() {
  const r = Readable.from(['z']);
  r.resume();
  await new Promise((resolve, reject) => finished(r, (err) => (err ? reject(err) : resolve())));
  console.log('finished ok');
}

async function testDuplex() {
  const written = [];
  const d = new Duplex({
    read() {
      this.push('r1');
      this.push(null);
    },
    write(chunk, enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  });
  d.write('w1');
  d.end();
  const reads = [];
  d.on('data', (c) => reads.push(c.toString()));
  await new Promise((resolve) => d.on('end', resolve));
  assert.deepEqual(written, ['w1']);
  assert.deepEqual(reads, ['r1']);
  console.log('duplex ok');
}

async function main() {
  await testFlowing();
  await testPauseResume();
  await testReadN();
  await testWritableDrain();
  await testWriteAfterEnd();
  await testTransformPipe();
  await testPassThroughBackpressure();
  await testPipeline();
  await testPipelineError();
  await testAsyncIteration();
  await testObjectMode();
  await testFinishedHelper();
  await testDuplex();
  console.log('ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
