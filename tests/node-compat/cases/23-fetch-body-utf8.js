// fetch Body codec must round-trip non-ASCII through UTF-8, not latin1 (issue
// #43). The bug was load-order: loader.js eager-requires fetch.js before
// encoding.js installs TextEncoder/TextDecoder, so fetch.js cached null codecs
// at load time and silently fell back to a latin1 round-trip (corrupting any
// multi-byte body — e.g. U+2615 truncated to byte 0x15). Response/Request use
// the same bodyToBytes/bytesToText path, so this reproduces without a network.
const assert = require('node:assert/strict');

async function main() {
	const s = 'héllo café ☕ 日本語';

	assert.equal(await new Response(s).text(), s);
	assert.equal(await new Request('http://example/', { method: 'POST', body: s }).text(), s);

	// The encoded bytes are UTF-8 (é = C3 A9), not a latin1 truncation.
	const bytes = new Uint8Array(await new Response('é').arrayBuffer());
	assert.deepEqual(Array.from(bytes), [0xc3, 0xa9]);

	// json() over a UTF-8 body.
	const obj = await new Response(JSON.stringify({ msg: 'café ☕' })).json();
	assert.equal(obj.msg, 'café ☕');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
