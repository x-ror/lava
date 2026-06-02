const assert = require('node:assert/strict');
const timers = require('node:timers/promises');

(async () => {
	const controller = new AbortController();
	const promise = timers.setTimeout(20, 'done', {signal: controller.signal});

	controller.abort();

	await assert.rejects(promise, {
		name: 'AbortError',
	});
})();

