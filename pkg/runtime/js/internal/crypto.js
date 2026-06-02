// node:crypto — minimal subset: createHash('sha256'), randomUUID(), randomBytes().
// SHA-256 is implemented in pure JS. Entropy currently comes from Math.random;
// this MUST be swapped for a native CSPRNG binding in the Odin phase (a weak
// source is fine to pass the format checks, NOT for real security).
(function (require, module) {
	"use strict";

	var Buffer = require("buffer").Buffer;

	var K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];

	function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

	function sha256(bytes) {
		var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

		var msg = bytes.slice();
		var bitLen = bytes.length * 8;
		msg.push(0x80);
		while (msg.length % 64 !== 56) msg.push(0);
		for (var i = 7; i >= 0; i--) msg.push(Math.floor(bitLen / Math.pow(2, i * 8)) & 0xff);

		var w = new Array(64);
		for (var off = 0; off < msg.length; off += 64) {
			for (var t = 0; t < 16; t++) {
				w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) >>> 0;
			}
			for (t = 16; t < 64; t++) {
				var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
				var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
			}
			var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
			for (t = 0; t < 64; t++) {
				var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				var ch = (e & f) ^ (~e & g);
				var temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
				var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				var maj = (a & b) ^ (a & c) ^ (b & c);
				var temp2 = (S0 + maj) >>> 0;
				h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
			}
			H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
			H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
		}

		var out = [];
		for (var j = 0; j < 8; j++) out.push((H[j] >>> 24) & 0xff, (H[j] >>> 16) & 0xff, (H[j] >>> 8) & 0xff, H[j] & 0xff);
		return out;
	}

	function toBytes(data, encoding) {
		if (typeof data === "string") {
			var buf = Buffer.from(data, encoding || "utf8");
			return Array.prototype.slice.call(buf);
		}
		return Array.prototype.slice.call(data);
	}

	function createHash(algorithm) {
		algorithm = String(algorithm).toLowerCase();
		if (algorithm !== "sha256") {
			throw new Error("Digest method not supported: " + algorithm);
		}
		var acc = [];
		var hash = {
			update: function (data, encoding) {
				var bytes = toBytes(data, encoding);
				for (var i = 0; i < bytes.length; i++) acc.push(bytes[i]);
				return hash;
			},
			digest: function (encoding) {
				var out = Buffer.from(sha256(acc));
				return encoding ? out.toString(encoding) : out;
			},
		};
		return hash;
	}

	// TODO(odin): replace with a native CSPRNG (read os entropy). Math.random is
	// NOT cryptographically secure; this only satisfies format/shape checks.
	function randomBytes(size) {
		var b = Buffer.alloc(size);
		for (var i = 0; i < size; i++) b[i] = Math.floor(Math.random() * 256);
		return b;
	}

	function randomUUID() {
		var b = randomBytes(16);
		b[6] = (b[6] & 0x0f) | 0x40; // version 4
		b[8] = (b[8] & 0x3f) | 0x80; // variant 10
		var h = [];
		for (var i = 0; i < 16; i++) {
			var s = b[i].toString(16);
			h.push(s.length === 1 ? "0" + s : s);
		}
		return (
			h.slice(0, 4).join("") + "-" +
			h.slice(4, 6).join("") + "-" +
			h.slice(6, 8).join("") + "-" +
			h.slice(8, 10).join("") + "-" +
			h.slice(10, 16).join("")
		);
	}

	module.exports = {
		createHash: createHash,
		randomBytes: randomBytes,
		randomUUID: randomUUID,
	};
})
