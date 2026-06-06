const assert = require('node:assert/strict');

async function main() {
	const events = [];

	queueMicrotask(() => {
		events.push('microtask');
	});

	await new Promise((resolve) => {
		setTimeout(() => {
			events.push('timeout');
			resolve();
		}, 0);
	});

	assert.deepEqual(events, ['microtask', 'timeout']);

	// Trailing arguments are forwarded to the callback on each fire.
	const timeoutArgs = await new Promise((resolve) => {
		setTimeout((a, b) => resolve([a, b]), 0, 'a', 'b');
	});
	assert.deepEqual(timeoutArgs, ['a', 'b']);

	const immediateArgs = await new Promise((resolve) => {
		setImmediate((a, b, c) => resolve([a, b, c]), 1, 2, 3);
	});
	assert.deepEqual(immediateArgs, [1, 2, 3]);

	// setInterval forwards the same arguments (by identity) on every fire.
	const intervalArgs = await new Promise((resolve) => {
		const seen = [];
		const obj = { id: 7 };
		const id = setInterval((o, label) => {
			seen.push([o.id, label]);
			if (seen.length === 2) {
				clearInterval(id);
				resolve(seen);
			}
		}, 0, obj, 'tick');
	});
	assert.deepEqual(intervalArgs, [[7, 'tick'], [7, 'tick']]);

	// No trailing arguments: the callback simply receives none.
	const noArgs = await new Promise((resolve) => {
		setTimeout((...rest) => resolve(rest.length), 0);
	});
	assert.equal(noArgs, 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
