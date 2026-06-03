const assert = require('node:assert/strict');
const {Blob, File} = require('node:buffer');

async function main() {
	const blob = new Blob(['foo', Buffer.from('bar'), new Uint8Array([0x21])], {type: 'Text/Plain'});
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
	assert.equal(new Blob([], {type: 'a\nb'}).type, ''); // non-printable type is dropped

	// node:buffer Blob/File are the same classes exposed as globals
	assert.equal(globalThis.Blob, Blob);
	assert.equal(globalThis.File, File);

	const file = new File(['hello'], 'greeting.txt', {type: 'text/plain', lastModified: 42});
	assert.equal(file instanceof Blob, true);
	assert.equal(file.name, 'greeting.txt');
	assert.equal(file.lastModified, 42);
	assert.equal(file.size, 5);
	assert.equal(await file.text(), 'hello');
	assert.throws(() => new File(['x']), TypeError); // File needs name argument
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
