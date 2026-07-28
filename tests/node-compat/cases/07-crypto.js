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

// ---------------------------------------------------------------------------
// Node/OpenSSL hash aliases. createHash/hash/createHmac/pbkdf2/hkdf accept the
// signature-style and legacy spellings (RSA-SHA256, sha256WithRSAEncryption,
// ssl3-md5, …) case-insensitively, and they resolve to the same digest as the
// canonical name. Each alias also appears in getHashes(). (Aliases for digests
// Lava lacks — RSA-RIPEMD160, RSA-SHA512/224 — are intentionally absent.)
const aliasGroups = {
  md5: ['RSA-MD5', 'md5WithRSAEncryption', 'ssl3-md5'],
  sha1: ['RSA-SHA1', 'RSA-SHA1-2', 'sha1WithRSAEncryption', 'ssl3-sha1'],
  sha224: ['RSA-SHA224', 'sha224WithRSAEncryption'],
  sha256: ['RSA-SHA256', 'sha256WithRSAEncryption'],
  sha384: ['RSA-SHA384', 'sha384WithRSAEncryption'],
  sha512: ['RSA-SHA512', 'sha512WithRSAEncryption'],
  'sha512-256': ['RSA-SHA512/256', 'sha512-256WithRSAEncryption'],
  'sha3-224': ['RSA-SHA3-224', 'id-rsassa-pkcs1-v1_5-with-sha3-224'],
  'sha3-256': ['RSA-SHA3-256', 'id-rsassa-pkcs1-v1_5-with-sha3-256'],
  'sha3-384': ['RSA-SHA3-384', 'id-rsassa-pkcs1-v1_5-with-sha3-384'],
  'sha3-512': ['RSA-SHA3-512', 'id-rsassa-pkcs1-v1_5-with-sha3-512'],
  sm3: ['RSA-SM3', 'sm3WithRSAEncryption'],
};
for (const [canonical, aliases] of Object.entries(aliasGroups)) {
  const refHash = crypto.createHash(canonical).update('lava').digest('hex');
  const refHmac = crypto.createHmac(canonical, 'key').update('lava').digest('hex');
  const refPbkdf2 = crypto.pbkdf2Sync('password', 'salt', 1, 8, canonical).toString('hex');
  for (const alias of aliases) {
    assert.equal(crypto.createHash(alias).update('lava').digest('hex'), refHash);
    assert.equal(crypto.hash(alias, 'lava'), refHash);
    assert.equal(crypto.createHmac(alias, 'key').update('lava').digest('hex'), refHmac);
    assert.equal(crypto.pbkdf2Sync('password', 'salt', 1, 8, alias).toString('hex'), refPbkdf2);
    assert.equal(crypto.getHashes().includes(alias), true);
    // Case-insensitive, matching OpenSSL.
    assert.equal(crypto.createHash(alias.toUpperCase()).update('lava').digest('hex'), refHash);
  }
}

// Unsupported / invalid digest names report exactly as Node does — and the
// error *shape* differs per API: createHash()/hash() throw a plain Error with
// no code, while the keyed digests throw TypeError ERR_CRYPTO_INVALID_DIGEST.
assert.throws(
  () => crypto.createHash('bogus'),
  (e) => {
    assert.equal(e.constructor, Error);
    assert.equal(e.message, 'Digest method not supported');
    assert.equal(e.code, undefined);
    return true;
  },
);
assert.throws(
  () => crypto.hash('bogus', 'x'),
  (e) => {
    assert.equal(e.constructor, Error);
    assert.equal(e.message, 'Digest method bogus is not supported');
    return true;
  },
);
assert.throws(() => crypto.createHmac('bogus', 'k'), {
  name: 'TypeError',
  code: 'ERR_CRYPTO_INVALID_DIGEST',
  message: 'Invalid digest: bogus',
});
// The invalid-digest message preserves the caller's original casing.
assert.throws(() => crypto.createHmac('BoGuS', 'k'), { message: 'Invalid digest: BoGuS' });
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1, 8, 'bogus'), {
  code: 'ERR_CRYPTO_INVALID_DIGEST',
});
assert.throws(
  () => crypto.hkdfSync('bogus', Buffer.alloc(8), Buffer.alloc(0), Buffer.alloc(0), 16),
  { code: 'ERR_CRYPTO_INVALID_DIGEST' },
);

// ---------------------------------------------------------------------------
// scrypt (RFC 7914), layered on the native PBKDF2 primitive. Vectors are taken
// from the RFC and from Node's output for the shared inputs.
assert.equal(
  crypto.scryptSync('', '', 64, { N: 16, r: 1, p: 1 }).toString('hex'),
  '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442' +
    'fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906',
);
assert.equal(
  crypto.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 }).toString('hex'),
  'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162' +
    '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
);
// Default parameters (N=16384, r=8, p=1).
const scryptDefault = '745731af4484f323968969eda289aeee005b5903ac561e64a5aca121797bf773';
assert.equal(crypto.scryptSync('password', 'salt', 32).toString('hex'), scryptDefault);
// cost / blockSize / parallelization are aliases for N / r / p.
assert.equal(
  crypto
    .scryptSync('password', 'salt', 16, { cost: 16, blockSize: 1, parallelization: 1 })
    .toString('hex'),
  crypto.scryptSync('password', 'salt', 16, { N: 16, r: 1, p: 1 }).toString('hex'),
);
// keylen 0 yields an empty key.
assert.equal(crypto.scryptSync('p', 's', 0).length, 0);
// Buffer/TypedArray inputs behave like the equivalent strings.
assert.equal(
  crypto.scryptSync(Buffer.from('password'), Buffer.from('salt'), 32).toString('hex'),
  scryptDefault,
);
// Parameter validation, matching Node's codes.
assert.throws(() => crypto.scryptSync('p', 's', 16, { N: 15 }), {
  name: 'RangeError',
  code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
  message: 'Invalid scrypt params',
});
assert.throws(() => crypto.scryptSync('p', 's', 16, { N: 1 }), {
  code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
});
assert.throws(() => crypto.scryptSync('p', 's', 16, { N: 16, cost: 16 }), {
  name: 'TypeError',
  code: 'ERR_INCOMPATIBLE_OPTION_PAIR',
  message: 'Option "N" cannot be used in combination with option "cost"',
});
// maxmem ceiling — the code matches Node (the trailing OpenSSL detail in Node's
// message is not reproduced, so only the code is asserted).
assert.throws(() => crypto.scryptSync('p', 's', 16, { N: 16, r: 1024, maxmem: 1024 }), {
  code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS',
});
assert.throws(() => crypto.scryptSync('p', 's', -1), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.scrypt('p', 's', 16), TypeError); // missing callback

// getFips() — Lava is never FIPS, so always 0, matching Node's default.
assert.equal(crypto.getFips(), 0);

// async scrypt resolves to the same key as the sync form.
crypto.scrypt('password', 'salt', 32, (err, dk) => {
  assert.ifError(err);
  assert.equal(dk.toString('hex'), scryptDefault);
});

// ---------------------------------------------------------------------------
// Argument validation (#106). Bad input must fail with Node's error class/code
// instead of being silently coerced into a hang, a wrong key, or a short fill.

// pbkdf2: iterations is validated 1..2^31-1 — -1 no longer wraps to 4294967295
// (a permanent sync hang) and >= 2^32 no longer truncates to a different key.
assert.throws(() => crypto.pbkdf2Sync('p', 's', -1, 32, 'sha256'), {
  name: 'RangeError',
  code: 'ERR_OUT_OF_RANGE',
});
assert.throws(() => crypto.pbkdf2Sync('p', 's', 0, 32, 'sha256'), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.pbkdf2Sync('p', 's', 2 ** 32, 32, 'sha256'), {
  code: 'ERR_OUT_OF_RANGE',
});
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1.5, 32, 'sha256'), { code: 'ERR_OUT_OF_RANGE' });
// keylen out of the int32 range throws ERR_OUT_OF_RANGE; keylen 0 is rejected
// by the underlying KDF (OpenSSL/Odin both refuse a zero-length derivation).
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1, -1, 'sha256'), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1, 2 ** 31, 'sha256'), {
  code: 'ERR_OUT_OF_RANGE',
});
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1, 0, 'sha256'));
// digest must be a string; password/salt must be byte sources (not numbers).
assert.throws(() => crypto.pbkdf2Sync('p', 's', 1, 8, 123), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => crypto.pbkdf2Sync(5, 's', 1, 8, 'sha256'), { code: 'ERR_INVALID_ARG_TYPE' });
// Known-answer test at a non-trivial iteration count (RFC 6070 vector): proves
// the full count runs and is neither wrapped nor truncated.
assert.equal(
  crypto.pbkdf2Sync('password', 'salt', 4096, 20, 'sha1').toString('hex'),
  '4b007901b765489abead49d926f721d065a429c1',
);

// randomBytes: a negative/NaN size throws instead of a huge allocation; a
// fractional size is truncated (Node parity), a non-number is a type error.
assert.throws(() => crypto.randomBytes(-1), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.randomBytes(NaN), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.randomBytes('4'), { code: 'ERR_INVALID_ARG_TYPE' });
assert.equal(crypto.randomBytes(1.5).length, 1);

// randomFillSync: range is validated (no silent truncation) and only the
// requested window is touched; ArrayBuffer and DataView inputs are supported.
assert.throws(() => crypto.randomFillSync(Buffer.alloc(4), 0, 10), { code: 'ERR_OUT_OF_RANGE' });
assert.throws(() => crypto.randomFillSync(Buffer.alloc(4), -1), { code: 'ERR_OUT_OF_RANGE' });
const windowed = new Uint8Array(8);
crypto.randomFillSync(windowed, 2, 3); // fills bytes [2,5) only
assert.equal(windowed[0], 0);
assert.equal(windowed[1], 0);
assert.equal(windowed[5], 0);
assert.equal(windowed[6], 0);
assert.equal(windowed[7], 0);
const abFill = new ArrayBuffer(16);
crypto.randomFillSync(abFill);
assert.ok(new Uint8Array(abFill).some((b) => b !== 0));
const dvFill = new DataView(new ArrayBuffer(16));
crypto.randomFillSync(dvFill);
assert.ok(new Uint8Array(dvFill.buffer).some((b) => b !== 0));

// Numeric/string inputs are rejected where Node rejects them (used to be
// silently zero-filled — timingSafeEqual(5, 5) wrongly returned true).
assert.throws(() => crypto.createHash('sha256').update(5), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => crypto.createHmac('sha256', 5), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => crypto.timingSafeEqual(5, 5), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => crypto.timingSafeEqual('abc', 'abc'), { code: 'ERR_INVALID_ARG_TYPE' });

// Zero-size CSPRNG boundary: every entry point succeeds and returns its
// argument; the fill APIs are identity even at zero length.
assert.equal(crypto.randomBytes(0).length, 0);
const zeroBuf = Buffer.alloc(0);
assert.equal(crypto.randomFillSync(zeroBuf), zeroBuf);

// A zero-size async request completes SYNCHRONOUSLY — Node queues no work for
// zero bytes, so the callback has already run when the call returns.
{
  let rbSync = false;
  crypto.randomBytes(0, () => {
    rbSync = true;
  });
  assert.equal(rbSync, true);
  let rfSync = false;
  crypto.randomFill(Buffer.alloc(0), () => {
    rfSync = true;
  });
  assert.equal(rfSync, true);
}
// And a bad buffer throws from randomFill itself, synchronously — not as an
// uncaught error out of the deferred fill.
assert.throws(() => crypto.randomFill('nope', () => {}), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => crypto.randomFill(Buffer.alloc(4), 9, () => {}), {
  code: 'ERR_OUT_OF_RANGE',
});
