const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const digest = crypto.createHash('sha256').update('lava').digest('hex');
const hmac = crypto.createHmac('sha256', 'key').update('lava').digest('hex');
const id = crypto.randomUUID();
const filled32 = new Uint32Array(2);
const filledRef = crypto.randomFillSync(filled32);
const key = crypto.pbkdf2Sync('password', 'salt', 1, 8, 'sha256');

assert.equal(digest, '5ed45566f29d2f055b2732b8bbae8d8dc7a4dce16cc6abb5d12aa1a6f82fc3a4');
assert.equal(hmac, 'dd87dadc971c655eb6e21240d0e77ba42082012f9779d8a5820228b8ba691042');
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(filledRef, filled32);
assert.ok(filled32[0] !== 0 || filled32[1] !== 0);
assert.equal(Buffer.from(key).toString('hex'), '120fb6cffcf8b32c');
assert.throws(() => crypto.pbkdf2Sync('password', 'salt', 1, 8), /digest/);
