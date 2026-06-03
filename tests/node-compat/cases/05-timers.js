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
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
