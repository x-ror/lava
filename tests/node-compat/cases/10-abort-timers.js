const assert = require('node:assert/strict');
const timers = require('node:timers/promises');

async function main() {
	assert.equal(typeof AbortController, 'function');
	assert.equal(typeof AbortSignal, 'function');

	// promisified timers resolve with their value
	assert.equal(await timers.setTimeout(5, 'done'), 'done');
	assert.equal(await timers.setImmediate('imm'), 'imm');

	// aborting before the timer fires rejects with an AbortError
	const controller = new AbortController();
	const pending = timers.setTimeout(50, 'x', {signal: controller.signal});
	controller.abort();
	await assert.rejects(pending, {name: 'AbortError'});

	// an already-aborted signal rejects immediately
	await assert.rejects(timers.setTimeout(5, 'y', {signal: AbortSignal.abort()}), {name: 'AbortError'});

	// AbortSignal.timeout: rejects with an AbortError carrying the TimeoutError as cause
	await assert.rejects(
		timers.setTimeout(1000, 'z', {signal: AbortSignal.timeout(5)}),
		(error) => error.name === 'AbortError' && error.cause && error.cause.name === 'TimeoutError',
	);

	// AbortSignal surface: aborted/reason/listener/throwIfAborted
	const c2 = new AbortController();
	assert.equal(c2.signal.aborted, false);
	let fired = 0;
	c2.signal.addEventListener('abort', () => { fired += 1; });
	c2.abort();
	assert.equal(c2.signal.aborted, true);
	assert.equal(fired, 1);
	assert.equal(c2.signal.reason.name, 'AbortError');
	assert.throws(() => c2.signal.throwIfAborted(), {name: 'AbortError'});

	// a custom abort reason is preserved
	const c3 = new AbortController();
	c3.abort(new TypeError('custom'));
	assert.equal(c3.signal.reason.message, 'custom');
	assert.equal(c3.signal.reason instanceof TypeError, true);

	// setInterval yields values and an abort ends iteration
	const c4 = new AbortController();
	const iterator = timers.setInterval(5, 'tick', {signal: c4.signal});
	assert.equal((await iterator.next()).value, 'tick');
	c4.abort();
	await assert.rejects(iterator.next(), {name: 'AbortError'});
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
