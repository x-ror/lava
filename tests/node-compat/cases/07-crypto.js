const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const digest = crypto.createHash('sha256').update('lava').digest('hex');
const id = crypto.randomUUID();

assert.equal(digest, '5ed45566f29d2f055b2732b8bbae8d8dc7a4dce16cc6abb5d12aa1a6f82fc3a4');
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
