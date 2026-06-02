const assert = require('node:assert/strict');

(async () => {
	const events = [];

	const timer = setTimeout(() => events.push('cancelled'), 0);
	clearTimeout(timer);
	setTimeout(() => events.push('kept'), 0);

	await new Promise((resolve) => setTimeout(resolve, 10));

	assert.deepEqual(events, ['kept']);
})();

