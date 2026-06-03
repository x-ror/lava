// node:buffer — Buffer implemented as a Uint8Array subclass. The hex/base64/utf8
// codecs are backed by Odin (pkg/runtime/buffer.odin) via the `native` bindings
// (fourth factory arg) and are the sole implementation — no JS fallback.
// ascii/latin1 stay pure JS. Also installs the global `Buffer` (Node exposes it
// without a require).
(function (require, module, exports, native) {
	"use strict";

	// Every codec is Odin-backed (pkg/runtime/buffer.odin); the loader supplies
	// `native` for every real instantiation. A missing binding means the module
	// is mis-wired — fail loudly here instead of shipping a slow JS shadow.
	if (!native) throw new Error("node:buffer requires native codec bindings");

	var utf8Encode = native.utf8Encode; // (string) -> Uint8Array
	var utf8Decode = native.utf8Decode; // (Uint8Array) -> string
	var hexEncode = native.hexEncode; // (Uint8Array) -> string
	var hexDecode = native.hexDecode; // (string) -> Uint8Array
	var base64Encode = native.base64Encode; // (Uint8Array) -> string

	// core:encoding/base64 expects clean, padded standard base64; Node is lenient
	// (ignores stray chars, tolerates missing padding). Normalize before handing
	// the string to the strict native decoder so we match Node's leniency.
	function normalizeBase64(str) {
		str = String(str).replace(/[^A-Za-z0-9+/]/g, "");
		if (str.length % 4 === 1) str = str.slice(0, str.length - 1); // a lone char is meaningless
		while (str.length % 4 !== 0) str += "=";
		return str;
	}

	function base64Decode(str) {
		var norm = normalizeBase64(str);
		return norm ? native.base64Decode(norm) : new Uint8Array(0);
	}

	function strToBytes(str, encoding) {
		encoding = (encoding || "utf8").toLowerCase();
		if (encoding === "utf8" || encoding === "utf-8") return utf8Encode(str);
		if (encoding === "hex") return hexDecode(str);
		if (encoding === "base64") return base64Decode(str);
		if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
			var a = [];
			for (var i = 0; i < str.length; i++) a.push(str.charCodeAt(i) & 0xff);
			return a;
		}
		throw new TypeError("Unknown encoding: " + encoding);
	}

	class Buffer extends Uint8Array {
		toString(encoding, start, end) {
			encoding = (encoding || "utf8").toLowerCase();
			start = start || 0;
			end = end === undefined ? this.length : end;
			if (encoding === "utf8" || encoding === "utf-8") return utf8Decode(this.subarray(start, end));
			if (encoding === "hex") return hexEncode(this.subarray(start, end));
			if (encoding === "base64") return base64Encode(this.subarray(start, end));
			if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
				var s = "";
				for (var i = start; i < end; i++) s += String.fromCharCode(encoding === "ascii" ? this[i] & 0x7f : this[i]);
				return s;
			}
			throw new TypeError("Unknown encoding: " + encoding);
		}

		copy(target, targetStart, sourceStart, sourceEnd) {
			targetStart = targetStart || 0;
			sourceStart = sourceStart || 0;
			sourceEnd = sourceEnd === undefined ? this.length : sourceEnd;
			var len = Math.min(sourceEnd, this.length) - sourceStart;
			if (len <= 0) return 0;
			len = Math.min(len, target.length - targetStart);
			target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
			return len;
		}

		write(string, offset, length, encoding) {
			offset = offset || 0;
			var bytes = strToBytes(string, encoding || "utf8");
			length = length === undefined ? bytes.length : Math.min(length, bytes.length);
			length = Math.min(length, this.length - offset);
			for (var i = 0; i < length; i++) this[offset + i] = bytes[i];
			return length;
		}

		slice(start, end) {
			var sub = this.subarray(start, end);
			return new Buffer(sub.buffer, sub.byteOffset, sub.length);
		}

		equals(other) {
			if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
			for (var i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
			return true;
		}

		toJSON() {
			return { type: "Buffer", data: Array.prototype.slice.call(this) };
		}
	}

	Buffer.from = function (value, encodingOrOffset, length) {
		if (typeof value === "string") {
			var bytes = strToBytes(value, encodingOrOffset);
			var b = new Buffer(bytes.length);
			b.set(bytes);
			return b;
		}
		if (value instanceof ArrayBuffer) {
			return new Buffer(value, encodingOrOffset || 0, length);
		}
		if (ArrayBuffer.isView(value) || Array.isArray(value)) {
			var copy = new Buffer(value.length);
			copy.set(value);
			return copy;
		}
		throw new TypeError("The first argument must be a string, Buffer, ArrayBuffer, Array, or Array-like Object.");
	};

	Buffer.alloc = function (size, fill, encoding) {
		var b = new Buffer(size);
		if (fill !== undefined && fill !== 0) {
			if (typeof fill === "number") {
				b.fill(fill);
			} else {
				var bytes = strToBytes(String(fill), encoding || "utf8");
				for (var i = 0; i < size; i++) b[i] = bytes[i % bytes.length];
			}
		}
		return b;
	};

	Buffer.allocUnsafe = function (size) {
		return new Buffer(size);
	};

	Buffer.isBuffer = function (b) {
		return b instanceof Buffer;
	};

	Buffer.byteLength = function (string, encoding) {
		if (typeof string !== "string") return string.length;
		return strToBytes(string, encoding || "utf8").length;
	};

	Buffer.concat = function (list, totalLength) {
		if (totalLength === undefined) {
			totalLength = 0;
			for (var i = 0; i < list.length; i++) totalLength += list[i].length;
		}
		var result = new Buffer(totalLength);
		var offset = 0;
		for (var j = 0; j < list.length; j++) {
			var item = list[j];
			if (offset + item.length > totalLength) {
				result.set(item.subarray(0, totalLength - offset), offset);
				break;
			}
			result.set(item, offset);
			offset += item.length;
		}
		return result;
	};

	if (typeof globalThis.Buffer === "undefined") {
		globalThis.Buffer = Buffer;
	}

	module.exports = { Buffer: Buffer, kMaxLength: 0x7fffffff, INSPECT_MAX_BYTES: 50 };
})
