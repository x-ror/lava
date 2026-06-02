const assert = require('node:assert/strict');

(async () => {
	const events = [];

	setTimeout(() => {
		events.push('timer-1');
		queueMicrotask(() => events.push('microtask-from-timer-1'));
	}, 0);

	setTimeout(() => {
		events.push('timer-2');
	}, 0);

	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(events, ['timer-1', 'microtask-from-timer-1', 'timer-2']);
})();

