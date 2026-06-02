// node:buffer — Buffer implemented as a Uint8Array subclass. Encodings are
// done by hand because JSC's bare context has no TextEncoder/TextDecoder.
// Also installs the global `Buffer` (Node exposes it without a require).
(function (require, module) {
	"use strict";

	function utf8Encode(str) {
		var bytes = [];
		for (var i = 0; i < str.length; i++) {
			var c = str.charCodeAt(i);
			if (c < 0x80) {
				bytes.push(c);
			} else if (c < 0x800) {
				bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
			} else if (c >= 0xd800 && c <= 0xdbff) {
				var c2 = str.charCodeAt(i + 1);
				if (c2 >= 0xdc00 && c2 <= 0xdfff) {
					var cp = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
					bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
					i++;
				} else {
					bytes.push(0xef, 0xbf, 0xbd);
				}
			} else if (c >= 0xdc00 && c <= 0xdfff) {
				bytes.push(0xef, 0xbf, 0xbd);
			} else {
				bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
			}
		}
		return bytes;
	}

	function utf8Decode(buf, start, end) {
		var out = "";
		var i = start;
		while (i < end) {
			var b = buf[i++];
			if (b < 0x80) {
				out += String.fromCharCode(b);
			} else if (b >= 0xc0 && b < 0xe0) {
				out += String.fromCharCode(((b & 0x1f) << 6) | (buf[i++] & 0x3f));
			} else if (b >= 0xe0 && b < 0xf0) {
				out += String.fromCharCode(((b & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f));
			} else if (b >= 0xf0) {
				var cp = ((b & 0x07) << 18) | ((buf[i++] & 0x3f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f);
				cp -= 0x10000;
				out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
			} else {
				out += "�";
			}
		}
		return out;
	}

	function hexEncode(buf, start, end) {
		var s = "";
		for (var i = start; i < end; i++) {
			var h = buf[i].toString(16);
			s += h.length === 1 ? "0" + h : h;
		}
		return s;
	}

	function hexDecode(str) {
		var bytes = [];
		for (var i = 0; i + 1 < str.length; i += 2) {
			var byte = parseInt(str.substr(i, 2), 16);
			if (isNaN(byte)) break;
			bytes.push(byte);
		}
		return bytes;
	}

	var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	function base64Encode(buf) {
		var s = "";
		var i;
		for (i = 0; i + 2 < buf.length; i += 3) {
			var n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
			s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
		}
		var rem = buf.length - i;
		if (rem === 1) {
			var n1 = buf[i] << 16;
			s += B64[(n1 >> 18) & 63] + B64[(n1 >> 12) & 63] + "==";
		} else if (rem === 2) {
			var n2 = (buf[i] << 16) | (buf[i + 1] << 8);
			s += B64[(n2 >> 18) & 63] + B64[(n2 >> 12) & 63] + B64[(n2 >> 6) & 63] + "=";
		}
		return s;
	}

	function base64Decode(str) {
		str = str.replace(/[^A-Za-z0-9+/]/g, "");
		var bytes = [];
		for (var i = 0; i + 3 < str.length; i += 4) {
			var n = (B64.indexOf(str[i]) << 18) | (B64.indexOf(str[i + 1]) << 12) | (B64.indexOf(str[i + 2]) << 6) | B64.indexOf(str[i + 3]);
			bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
		}
		var rem = str.length % 4;
		if (rem === 2) {
			var a = (B64.indexOf(str[str.length - 2]) << 18) | (B64.indexOf(str[str.length - 1]) << 12);
			bytes.push((a >> 16) & 0xff);
		} else if (rem === 3) {
			var b = (B64.indexOf(str[str.length - 3]) << 18) | (B64.indexOf(str[str.length - 2]) << 12) | (B64.indexOf(str[str.length - 1]) << 6);
			bytes.push((b >> 16) & 0xff, (b >> 8) & 0xff);
		}
		return bytes;
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
			if (encoding === "utf8" || encoding === "utf-8") return utf8Decode(this, start, end);
			if (encoding === "hex") return hexEncode(this, start, end);
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
