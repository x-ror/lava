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

// one-shot crypto.hash plus Hash/Hmac classes and copy()
assert.equal(crypto.hash('sha256', 'lava'), digest);
assert.ok(Buffer.isBuffer(crypto.hash('sha256', 'lava', 'buffer')));
assert.ok(crypto.createHash('sha256') instanceof crypto.Hash);
assert.ok(crypto.createHmac('sha256', 'key') instanceof crypto.Hmac);
const partial = crypto.createHash('sha256').update('la');
const forked = partial.copy();
assert.equal(partial.update('va').digest('hex'), digest);
assert.equal(forked.update('va').digest('hex'), digest);
assert.equal(crypto.getHashes().includes('sha256'), true);

// Hash/Hmac snapshot byte input at update/key time, and finalize after digest()
const mutableHashInput = Buffer.from('lava');
const mutableHash = crypto.createHash('sha256').update(mutableHashInput);
mutableHashInput[0] = 0x6a; // "java"; must not affect the already-updated hash
assert.equal(mutableHash.digest('hex'), digest);

const finalizedHash = crypto.createHash('sha256');
finalizedHash.digest('hex');
assert.throws(() => finalizedHash.digest('hex'), {code: 'ERR_CRYPTO_HASH_FINALIZED'});
assert.throws(() => finalizedHash.update('x'), {code: 'ERR_CRYPTO_HASH_FINALIZED'});
assert.throws(() => finalizedHash.copy(), {code: 'ERR_CRYPTO_HASH_FINALIZED'});

const mutableHmacKey = Buffer.from('key');
const mutableHmacInput = Buffer.from('lava');
const mutableHmac = crypto.createHmac('sha256', mutableHmacKey).update(mutableHmacInput);
mutableHmacKey[0] = 0x4b;
mutableHmacInput[0] = 0x6a;
assert.equal(mutableHmac.digest('hex'), hmac);

const finalizedHmac = crypto.createHmac('sha256', 'key');
finalizedHmac.digest('hex');
assert.equal(finalizedHmac.digest('hex'), '');
assert.throws(() => finalizedHmac.update('x'), {code: 'ERR_CRYPTO_HASH_FINALIZED'});

// constant-time comparison
assert.equal(crypto.timingSafeEqual(Buffer.from('lava'), Buffer.from('lava')), true);
assert.equal(crypto.timingSafeEqual(Buffer.from('lava'), Buffer.from('java')), false);
assert.throws(() => crypto.timingSafeEqual(Buffer.from('a'), Buffer.from('bb')), RangeError);

// uniform bounded random integers
for (let i = 0; i < 256; i++) {
	const value = crypto.randomInt(100, 200);
	assert.equal(Number.isInteger(value) && value >= 100 && value < 200, true);
}
assert.throws(() => crypto.randomInt(5, 1), RangeError);

// HKDF, RFC 5869 test case 1
const okm = Buffer.from(crypto.hkdfSync(
	'sha256',
	Buffer.alloc(22, 0x0b),
	Buffer.from('000102030405060708090a0b0c', 'hex'),
	Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
	42,
));
assert.equal(okm.toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');

assert.equal(crypto.constants.RSA_PKCS1_OAEP_PADDING, 4);
