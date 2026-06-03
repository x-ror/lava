// node:crypto — hashing, HMAC, CSPRNG and PBKDF2 backed by the Odin crypto
// stdlib. The `native` bindings object (fourth factory argument, supplied by the
// loader) exposes four primitives implemented in pkg/runtime/crypto.odin:
//
//   native.randomFill(typedArray)              -> fills in place with OS CSPRNG bytes
//   native.hash(algo, Uint8Array)              -> digest Uint8Array
//   native.hmac(algo, key, data)               -> HMAC Uint8Array
//   native.pbkdf2(algo, password, salt, it, n) -> derived-key Uint8Array
//
// Streaming (createHash().update()…digest()) is handled here by accumulating
// chunks and calling the one-shot native primitive once at digest time, so no
// streaming state has to cross the native boundary.
(function (require, module, exports, native) {
	"use strict";

	var Buffer = require("buffer").Buffer;

	// --- helpers -------------------------------------------------------------

	function toU8(data, encoding) {
		if (data instanceof Uint8Array) return data; // Buffer included (subclass)
		if (typeof data === "string") return new Uint8Array(Buffer.from(data, encoding || "utf8"));
		return new Uint8Array(data); // array-like / array of byte values
	}

	function concat(chunks) {
		if (chunks.length === 1) return chunks[0];
		var total = 0, i;
		for (i = 0; i < chunks.length; i++) total += chunks[i].length;
		var out = new Uint8Array(total), off = 0;
		for (i = 0; i < chunks.length; i++) {
			out.set(chunks[i], off);
			off += chunks[i].length;
		}
		return out;
	}

	function normalizeAlgo(algorithm) {
		return String(algorithm).toLowerCase();
	}

	// Hash algorithms the Odin native layer (crypto_algorithm) can service.
	var HASHES = [
		"md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-256",
		"sha3-224", "sha3-256", "sha3-384", "sha3-512",
	];

	function getHashes() {
		return HASHES.slice();
	}

	// --- hashing -------------------------------------------------------------

	// Hash/Hmac accumulate chunks and call the one-shot native primitive at
	// digest time (no streaming state crosses the boundary). Methods live on the
	// prototype and the constructors are exported so the surface matches Node,
	// where createHash()/createHmac() return Hash/Hmac instances.

	function Hash(algorithm) {
		if (!(this instanceof Hash)) return new Hash(algorithm);
		this._algo = normalizeAlgo(algorithm);
		this._chunks = [];
	}
	Hash.prototype.update = function (data, encoding) {
		this._chunks.push(toU8(data, encoding));
		return this;
	};
	Hash.prototype.digest = function (encoding) {
		var out = Buffer.from(native.hash(this._algo, concat(this._chunks)));
		return encoding ? out.toString(encoding) : out;
	};
	Hash.prototype.copy = function () {
		var clone = new Hash(this._algo);
		clone._chunks = this._chunks.slice();
		return clone;
	};

	function Hmac(algorithm, key) {
		if (!(this instanceof Hmac)) return new Hmac(algorithm, key);
		this._algo = normalizeAlgo(algorithm);
		this._key = toU8(key);
		this._chunks = [];
	}
	Hmac.prototype.update = function (data, encoding) {
		this._chunks.push(toU8(data, encoding));
		return this;
	};
	Hmac.prototype.digest = function (encoding) {
		var out = Buffer.from(native.hmac(this._algo, this._key, concat(this._chunks)));
		return encoding ? out.toString(encoding) : out;
	};

	function createHash(algorithm) {
		return new Hash(algorithm);
	}

	function createHmac(algorithm, key) {
		return new Hmac(algorithm, key);
	}

	// crypto.hash(algorithm, data[, outputEncoding]) — one-shot digest (Node 21+).
	// outputEncoding defaults to "hex"; "buffer" yields a Buffer.
	function hash(algorithm, data, outputEncoding) {
		var out = Buffer.from(native.hash(normalizeAlgo(algorithm), toU8(data)));
		if (outputEncoding === undefined || outputEncoding === "hex") return out.toString("hex");
		if (outputEncoding === "buffer") return out;
		return out.toString(outputEncoding);
	}

	// --- randomness ----------------------------------------------------------

	function randomBytes(size, callback) {
		var buf = Buffer.alloc(size);
		native.randomFill(buf);
		if (typeof callback === "function") {
			setImmediate(function () { callback(null, buf); });
			return undefined;
		}
		return buf;
	}

	function randomFillSync(buffer, offset, size) {
		if (offset === undefined && size === undefined) {
			native.randomFill(buffer);
			return buffer;
		}
		offset = offset || 0;
		var end = size === undefined ? buffer.length : offset + size;
		// subarray shares the backing store, so the native fill writes through.
		native.randomFill(buffer.subarray(offset, end));
		return buffer;
	}

	function randomFill(buffer, offset, size, callback) {
		if (typeof offset === "function") { callback = offset; offset = undefined; size = undefined; }
		else if (typeof size === "function") { callback = size; size = undefined; }
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		setImmediate(function () { callback(null, randomFillSync(buffer, offset, size)); });
	}

	var HEX = "0123456789abcdef";

	function randomUUID() {
		var b = randomBytes(16);
		b[6] = (b[6] & 0x0f) | 0x40; // version 4
		b[8] = (b[8] & 0x3f) | 0x80; // variant 10
		var s = "";
		for (var i = 0; i < 16; i++) {
			s += HEX[(b[i] >> 4) & 0xf] + HEX[b[i] & 0xf];
			if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
		}
		return s;
	}

	// Constant-time comparison: never short-circuits on the first differing byte.
	function timingSafeEqual(a, b) {
		var ua = toU8(a), ub = toU8(b);
		if (ua.length !== ub.length) throw new RangeError("Input buffers must have the same byte length");
		var diff = 0;
		for (var i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
		return diff === 0;
	}

	// randomInt([min, ] max[, callback]) — uniform integer in [min, max) via
	// rejection sampling over 48 random bits (Node caps the range at 2^48).
	function randomInt(min, max, callback) {
		if (typeof min === "function") { callback = min; min = undefined; max = undefined; }
		else if (typeof max === "function") { callback = max; max = undefined; }
		if (max === undefined) { max = min; min = 0; }
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
			throw new RangeError("The value of \"min\"/\"max\" is out of range. It must be a safe integer.");
		}
		if (max <= min) throw new RangeError("The value of \"max\" is out of range. It must be greater than the value of \"min\".");
		var range = max - min;
		if (range > 0x1000000000000) throw new RangeError("The value of \"max - min\" is out of range. It must be <= 2^48.");

		function sample() {
			var limit = 0x1000000000000 - (0x1000000000000 % range), value;
			do {
				var r = randomBytes(6);
				value = r[0] * 0x10000000000 + r[1] * 0x100000000 + r[2] * 0x1000000 + r[3] * 0x10000 + r[4] * 0x100 + r[5];
			} while (value >= limit);
			return min + (value % range);
		}

		if (typeof callback === "function") {
			setImmediate(function () {
				var value;
				try { value = sample(); } catch (err) { callback(err); return; }
				callback(null, value);
			});
			return undefined;
		}
		return sample();
	}

	// --- key derivation ------------------------------------------------------

	function pbkdf2Sync(password, salt, iterations, keylen, digest) {
		if (typeof digest !== "string") throw new TypeError("The \"digest\" argument must be of type string");
		var out = native.pbkdf2(normalizeAlgo(digest), toU8(password), toU8(salt), iterations >>> 0, keylen);
		return Buffer.from(out);
	}

	function pbkdf2(password, salt, iterations, keylen, digest, callback) {
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		setImmediate(function () {
			var key;
			try {
				key = pbkdf2Sync(password, salt, iterations, keylen, digest);
			} catch (err) {
				callback(err);
				return;
			}
			callback(null, key);
		});
	}

	// hkdfSync(digest, ikm, salt, info, keylen) — RFC 5869 HKDF over the native
	// HMAC primitive. Returns an ArrayBuffer, matching Node.
	function hkdfSync(digest, ikm, salt, info, keylen) {
		var algo = normalizeAlgo(digest);
		var ikmBytes = toU8(ikm), infoBytes = toU8(info);
		var hashLen = native.hash(algo, new Uint8Array(0)).length; // probe digest size
		var saltBytes = toU8(salt);
		if (saltBytes.length === 0) saltBytes = new Uint8Array(hashLen); // default: hashLen zero bytes
		if (keylen > 255 * hashLen) throw new RangeError("Invalid key length");

		var prk = native.hmac(algo, saltBytes, ikmBytes); // extract
		var blocks = Math.ceil(keylen / hashLen);
		var okm = new Uint8Array(blocks * hashLen);
		var prev = new Uint8Array(0);
		for (var i = 0; i < blocks; i++) {
			var input = new Uint8Array(prev.length + infoBytes.length + 1);
			input.set(prev, 0);
			input.set(infoBytes, prev.length);
			input[input.length - 1] = i + 1;
			prev = native.hmac(algo, prk, input); // expand
			okm.set(prev, i * hashLen);
		}
		return okm.slice(0, keylen).buffer;
	}

	function hkdf(digest, ikm, salt, info, keylen, callback) {
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		setImmediate(function () {
			var key;
			try { key = hkdfSync(digest, ikm, salt, info, keylen); }
			catch (err) { callback(err); return; }
			callback(null, key);
		});
	}

	// A small, real subset of crypto.constants (RSA padding modes). Values are
	// stable OpenSSL constants; included for code that references them even
	// before the corresponding cipher/key APIs exist.
	var constants = {
		RSA_PKCS1_PADDING: 1,
		RSA_NO_PADDING: 3,
		RSA_PKCS1_OAEP_PADDING: 4,
		RSA_PKCS1_PSS_PADDING: 6,
		RSA_PSS_SALTLEN_DIGEST: -1,
		RSA_PSS_SALTLEN_MAX_SIGN: -2,
		RSA_PSS_SALTLEN_AUTO: -2,
	};

	module.exports = {
		Hash: Hash,
		Hmac: Hmac,
		createHash: createHash,
		createHmac: createHmac,
		hash: hash,
		getHashes: getHashes,
		timingSafeEqual: timingSafeEqual,
		randomBytes: randomBytes,
		randomFillSync: randomFillSync,
		randomFill: randomFill,
		randomInt: randomInt,
		randomUUID: randomUUID,
		pbkdf2: pbkdf2,
		pbkdf2Sync: pbkdf2Sync,
		hkdf: hkdf,
		hkdfSync: hkdfSync,
		constants: constants,
	};
})
