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

	// --- hashing -------------------------------------------------------------

	function createHash(algorithm) {
		var algo = normalizeAlgo(algorithm);
		var chunks = [];
		var hash = {
			update: function (data, encoding) {
				chunks.push(toU8(data, encoding));
				return hash;
			},
			digest: function (encoding) {
				var out = Buffer.from(native.hash(algo, concat(chunks)));
				return encoding ? out.toString(encoding) : out;
			},
		};
		return hash;
	}

	function createHmac(algorithm, key) {
		var algo = normalizeAlgo(algorithm);
		var keyBytes = toU8(key);
		var chunks = [];
		var hmac = {
			update: function (data, encoding) {
				chunks.push(toU8(data, encoding));
				return hmac;
			},
			digest: function (encoding) {
				var out = Buffer.from(native.hmac(algo, keyBytes, concat(chunks)));
				return encoding ? out.toString(encoding) : out;
			},
		};
		return hmac;
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

	module.exports = {
		createHash: createHash,
		createHmac: createHmac,
		randomBytes: randomBytes,
		randomFillSync: randomFillSync,
		randomFill: randomFill,
		randomUUID: randomUUID,
		pbkdf2: pbkdf2,
		pbkdf2Sync: pbkdf2Sync,
	};
})
