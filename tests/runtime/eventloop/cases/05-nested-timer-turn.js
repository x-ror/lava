const assert = require('node:assert/strict');

(async () => {
	const events = [];

	setTimeout(() => {
		events.push(1);
		setTimeout(() => events.push(3), 0);
	}, 0);

	setTimeout(() => events.push(2), 0);

	await new Promise((resolve) => setTimeout(resolve, 20));

	assert.deepEqual(events, [1, 2, 3]);
})();

