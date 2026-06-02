const assert = require('node:assert/strict');

(async () => {
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
})();
