// TextEncoder / TextDecoder (WHATWG Encoding standard), installed as globals.
// Built on Buffer for utf-8 and utf-16le; windows-1252 (the WHATWG alias for
// latin1/ascii) uses an explicit high-byte table so it is exact, not approximate.
(function (require, module, exports) {
	"use strict";

	var bufferModule = require("buffer");
	var Buffer = bufferModule.Buffer;

	// Label -> canonical encoding name. Only encodings Lava can service are
	// listed; an unknown label makes the TextDecoder constructor throw, like Node.
	var LABELS = {
		"utf-8": "utf-8", "utf8": "utf-8", "unicode-1-1-utf-8": "utf-8",
		"unicode11utf8": "utf-8", "unicode20utf8": "utf-8", "x-unicode20utf8": "utf-8",
		"utf-16le": "utf-16le", "utf-16": "utf-16le", "ucs-2": "utf-16le",
		"unicode": "utf-16le", "unicodefeff": "utf-16le", "csunicode": "utf-16le",
		"iso-10646-ucs-2": "utf-16le",
		"windows-1252": "windows-1252", "latin1": "windows-1252", "iso-8859-1": "windows-1252",
		"iso8859-1": "windows-1252", "iso88591": "windows-1252", "cp1252": "windows-1252",
		"x-cp1252": "windows-1252", "cp819": "windows-1252", "ibm819": "windows-1252", "l1": "windows-1252",
		"ascii": "windows-1252", "us-ascii": "windows-1252", "ansi_x3.4-1968": "windows-1252",
	};

	// windows-1252 code points for bytes 0x80-0x9F (others equal the byte value).
	var WIN1252_HIGH = [
		8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143,
		144, 8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376,
	];

	function normalizeLabel(label) {
		return LABELS[String(label === undefined ? "utf-8" : label).trim().toLowerCase()];
	}

	function toBytes(input, who) {
		if (input === undefined) return new Uint8Array(0);
		if (input instanceof Uint8Array) return input;
		if (input instanceof ArrayBuffer) return new Uint8Array(input);
		if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
		throw new TypeError("The \"" + who + "\" argument must be an instance of ArrayBuffer or a view");
	}

	// --- TextEncoder (utf-8 only, per spec) ----------------------------------

	function TextEncoder() {
		if (!(this instanceof TextEncoder)) throw new TypeError("Constructor TextEncoder requires 'new'");
	}
	Object.defineProperty(TextEncoder.prototype, "encoding", { get: function () { return "utf-8"; }, configurable: true });

	TextEncoder.prototype.encode = function (input) {
		return new Uint8Array(Buffer.from(input === undefined ? "" : String(input), "utf8"));
	};

	function encodeCodePoint(cp, dest, offset) {
		if (cp <= 0x7f) { dest[offset] = cp; return 1; }
		if (cp <= 0x7ff) {
			dest[offset] = 0xc0 | (cp >> 6);
			dest[offset + 1] = 0x80 | (cp & 0x3f);
			return 2;
		}
		if (cp <= 0xffff) {
			dest[offset] = 0xe0 | (cp >> 12);
			dest[offset + 1] = 0x80 | ((cp >> 6) & 0x3f);
			dest[offset + 2] = 0x80 | (cp & 0x3f);
			return 3;
		}
		dest[offset] = 0xf0 | (cp >> 18);
		dest[offset + 1] = 0x80 | ((cp >> 12) & 0x3f);
		dest[offset + 2] = 0x80 | ((cp >> 6) & 0x3f);
		dest[offset + 3] = 0x80 | (cp & 0x3f);
		return 4;
	}

	TextEncoder.prototype.encodeInto = function (source, dest) {
		if (!(dest instanceof Uint8Array)) throw new TypeError("The \"dest\" argument must be an instance of Uint8Array");
		source = String(source);
		var read = 0, written = 0, capacity = dest.length;
		for (var i = 0; i < source.length;) {
			var cp = source.codePointAt(i);
			var units = cp > 0xffff ? 2 : 1;
			if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate
			var size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
			if (written + size > capacity) break;
			written += encodeCodePoint(cp, dest, written);
			read += units;
			i += units;
		}
		return { read: read, written: written };
	};

	// --- TextDecoder ----------------------------------------------------------

	function TextDecoder(label, options) {
		if (!(this instanceof TextDecoder)) throw new TypeError("Constructor TextDecoder requires 'new'");
		var enc = normalizeLabel(label);
		if (enc === undefined) throw new RangeError("The encoding label provided ('" + label + "') is invalid.");
		options = options || {};
		Object.defineProperty(this, "_enc", { value: enc });
		Object.defineProperty(this, "_fatal", { value: !!options.fatal });
		Object.defineProperty(this, "_ignoreBOM", { value: !!options.ignoreBOM });
	}
	Object.defineProperty(TextDecoder.prototype, "encoding", { get: function () { return this._enc; }, configurable: true });
	Object.defineProperty(TextDecoder.prototype, "fatal", { get: function () { return this._fatal; }, configurable: true });
	Object.defineProperty(TextDecoder.prototype, "ignoreBOM", { get: function () { return this._ignoreBOM; }, configurable: true });

	function decodeWin1252(bytes) {
		var out = "";
		for (var i = 0; i < bytes.length; i++) {
			var b = bytes[i];
			out += String.fromCharCode(b >= 0x80 && b <= 0x9f ? WIN1252_HIGH[b - 0x80] : b);
		}
		return out;
	}

	TextDecoder.prototype.decode = function (input) {
		var bytes = toBytes(input, "input");
		var result;
		if (this._enc === "windows-1252") {
			result = decodeWin1252(bytes);
		} else if (this._enc === "utf-8") {
			if (this._fatal && !bufferModule.isUtf8(bytes)) {
				throw new TypeError("The encoded data was not valid for encoding utf-8");
			}
			result = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
		} else {
			result = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf16le");
		}
		if (!this._ignoreBOM && result.charCodeAt(0) === 0xfeff) result = result.slice(1);
		return result;
	};

	if (typeof globalThis.TextEncoder === "undefined") globalThis.TextEncoder = TextEncoder;
	if (typeof globalThis.TextDecoder === "undefined") globalThis.TextDecoder = TextDecoder;

	module.exports = { TextEncoder: TextEncoder, TextDecoder: TextDecoder };
})
