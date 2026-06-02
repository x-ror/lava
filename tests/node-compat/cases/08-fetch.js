const assert = require('node:assert/strict');

(async () => {
	const response = new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
		status: 201,
	});

	assert.equal(typeof fetch, 'function');
	assert.equal(response.status, 201);
	assert.equal(response.headers.get('content-type'), 'application/json');
	assert.deepEqual(await response.json(), { ok: true });
})();
