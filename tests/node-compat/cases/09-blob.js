const assert = require('node:assert/strict');
const { Blob, File } = require('node:buffer');

async function main() {
  const blob = new Blob(['foo', Buffer.from('bar'), new Uint8Array([0x21])], {
    type: 'Text/Plain',
  });
  assert.equal(blob.size, 7);
  assert.equal(blob.type, 'text/plain'); // type is lowercased
  assert.equal(await blob.text(), 'foobar!');
  assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), 'foobar!');
  assert.deepEqual(await blob.bytes(), new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72, 0x21]));

  const slice = blob.slice(3, 6, 'x/y');
  assert.equal(slice.size, 3);
  assert.equal(slice.type, 'x/y');
  assert.equal(await slice.text(), 'bar');
  assert.equal(await blob.slice(-1).text(), '!'); // negative offset
  assert.equal(new Blob([], { type: 'a\nb' }).type, ''); // non-printable type is dropped

  // node:buffer Blob/File are the same classes exposed as globals
  assert.equal(globalThis.Blob, Blob);
  assert.equal(globalThis.File, File);

  const file = new File(['hello'], 'greeting.txt', { type: 'text/plain', lastModified: 42 });
  assert.equal(file instanceof Blob, true);
  assert.equal(file.name, 'greeting.txt');
  assert.equal(file.lastModified, 42);
  assert.equal(file.size, 5);
  assert.equal(await file.text(), 'hello');
  assert.throws(() => new File(['x']), TypeError); // File needs name argument

  // Blob.stream() yields the bytes through a WHATWG ReadableStream. Assert on
  // reassembled content (not chunk count) so the test stays robust to how the
  // bytes are partitioned.
  const sblob = new Blob(['foo', Buffer.from('bar'), new Uint8Array([0x21])]);
  const stream = sblob.stream();
  assert.equal(stream.constructor.name, 'ReadableStream');
  const reader = stream.getReader();
  const collected = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    assert.ok(value instanceof Uint8Array, 'stream chunks are Uint8Array');
    for (const byte of value) collected.push(byte);
  }
  assert.deepEqual(
    new Uint8Array(collected),
    new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72, 0x21]),
  );

  // The chunk is a copy: mutating it must not change the Blob's bytes.
  const r2 = sblob.stream().getReader();
  const { value: firstChunk } = await r2.read();
  firstChunk[0] = 0;
  assert.equal(await sblob.text(), 'foobar!', 'mutating a stream chunk leaves the Blob intact');
  await r2.cancel();

  // An empty Blob produces a stream that closes immediately with no data.
  const emptyReader = new Blob([]).stream().getReader();
  assert.equal((await emptyReader.read()).done, true, 'empty Blob stream closes immediately');

  // The stream is async-iterable.
  let viaIter = '';
  for await (const chunk of new Blob(['hello world']).stream()) {
    viaIter += Buffer.from(chunk).toString();
  }
  assert.equal(viaIter, 'hello world');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
