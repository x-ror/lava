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

// BLAKE2 and SM3 digests, served by the same Odin core:crypto/hash interface and
// exercised through createHash/hash, createHmac, and getHashes(). Vectors are
// Node's output for the shared 'lava'/'key' inputs used above.
const blake2b512 =
  'ed2807e5432a1f5e5cb553cde7531bea3d11912fcb4181d5c88701c55aea9c390e1a808b8a5d36bc977fc06824608c01eedf38f43e45edcdbda9543d30ba42eb';
const blake2s256 = '7c32c2e0e882663ff209f64d177449954fb5f14fa1f6af8731ef1f22992d880f';
const sm3 = 'd26e27dc1877fb10e21acd8a907f8616ef65a2b2d3703a25c0ba29e20980e529';
assert.equal(crypto.createHash('blake2b512').update('lava').digest('hex'), blake2b512);
assert.equal(crypto.createHash('blake2s256').update('lava').digest('hex'), blake2s256);
assert.equal(crypto.createHash('sm3').update('lava').digest('hex'), sm3);
assert.equal(crypto.hash('blake2b512', 'lava'), blake2b512);
assert.equal(crypto.hash('blake2s256', 'lava'), blake2s256);
assert.equal(crypto.hash('sm3', 'lava'), sm3);
assert.equal(crypto.createHash('blake2b512').update('lava').digest().length, 64);
assert.equal(crypto.createHash('blake2s256').update('lava').digest().length, 32);
assert.equal(crypto.createHash('sm3').update('lava').digest().length, 32);
assert.equal(
  crypto.createHmac('blake2b512', 'key').update('lava').digest('hex'),
  'ea0dbc86ac6f1c1850bd389f6163349248d3cfdae04faf714f14b04906c2771eb8e6c81b3b9ede207b99fa844e8a94e21ee91acdbcfe3faf0d95d7f814205dd7',
);
assert.equal(
  crypto.createHmac('blake2s256', 'key').update('lava').digest('hex'),
  '7abeda0371857341bb56a310b253ba4db37a1e44fd086113695eb45fcd7e4dda',
);
assert.equal(
  crypto.createHmac('sm3', 'key').update('lava').digest('hex'),
  '3427691b7a3cfa72f87c29ac58ec515005b47978abce1ebdc8347ee42aaa77ce',
);
for (const algo of ['blake2b512', 'blake2s256', 'sm3'])
  assert.equal(crypto.getHashes().includes(algo), true);

// The same algorithms flow through the HMAC-based KDFs (pbkdf2/hkdf) for free.
assert.equal(
  crypto.pbkdf2Sync('password', 'salt', 1, 8, 'sm3').toString('hex'),
  '4612f922a1fdcefa',
);
assert.equal(
  Buffer.from(
    crypto.hkdfSync(
      'blake2s256',
      Buffer.alloc(22, 0x0b),
      Buffer.from('000102030405060708090a0b0c', 'hex'),
      Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
      42,
    ),
  ).toString('hex'),
  '1472c31f2ff768c71b19f8803683ee3b13c1a5fb3ea59c0c3bf0d44a4a40dcd4329d9cd85bbe35a1b3e7',
);

// Hash/Hmac snapshot byte input at update/key time, and finalize after digest()
const mutableHashInput = Buffer.from('lava');
const mutableHash = crypto.createHash('sha256').update(mutableHashInput);
mutableHashInput[0] = 0x6a; // "java"; must not affect the already-updated hash
assert.equal(mutableHash.digest('hex'), digest);

const finalizedHash = crypto.createHash('sha256');
finalizedHash.digest('hex');
assert.throws(() => finalizedHash.digest('hex'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
assert.throws(() => finalizedHash.update('x'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });
assert.throws(() => finalizedHash.copy(), { code: 'ERR_CRYPTO_HASH_FINALIZED' });

const mutableHmacKey = Buffer.from('key');
const mutableHmacInput = Buffer.from('lava');
const mutableHmac = crypto.createHmac('sha256', mutableHmacKey).update(mutableHmacInput);
mutableHmacKey[0] = 0x4b;
mutableHmacInput[0] = 0x6a;
assert.equal(mutableHmac.digest('hex'), hmac);

const finalizedHmac = crypto.createHmac('sha256', 'key');
finalizedHmac.digest('hex');
assert.equal(finalizedHmac.digest('hex'), '');
assert.throws(() => finalizedHmac.update('x'), { code: 'ERR_CRYPTO_HASH_FINALIZED' });

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
const okm = Buffer.from(
  crypto.hkdfSync(
    'sha256',
    Buffer.alloc(22, 0x0b),
    Buffer.from('000102030405060708090a0b0c', 'hex'),
    Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
    42,
  ),
);
assert.equal(
  okm.toString('hex'),
  '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
);

assert.equal(crypto.constants.RSA_PKCS1_OAEP_PADDING, 4);
