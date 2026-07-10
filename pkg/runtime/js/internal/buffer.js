// node:buffer — Buffer implemented as a Uint8Array subclass. The hot codecs are
// backed by Odin (pkg/runtime/buffer.odin); API glue and Node compatibility
// behavior live here.
(function (require, module, exports, native) {
  'use strict';

  if (!native) throw new Error('node:buffer requires native codec bindings');

  // (size) -> uninitialized Uint8Array | null — native uninitialized allocation
  // backing the unpooled unsafe paths; null signals "fall back to a zero-filled
  // own-backing Buffer" (binding missing or allocation failed). See allocUnsafeNoZero.
  var nativeAllocUninit = typeof native.allocUninit === 'function' ? native.allocUninit : null;
  // Native byte-op / codec fast paths, feature-detected so an older native build
  // still works through the JS fallbacks below. Below the size thresholds the FFI
  // crossing costs more than a tight JS loop (measured ~550–750ns fixed cost on
  // javascriptcoregtk), so tiny inputs stay in JS.
  var nativeCompare = typeof native.compare === 'function' ? native.compare : null;
  var nativeIndexOf = typeof native.indexOf === 'function' ? native.indexOf : null;
  var nativeIsValidUtf8 = typeof native.isValidUtf8 === 'function' ? native.isValidUtf8 : null;
  var nativeUtf8WriteInto =
    typeof native.utf8WriteInto === 'function' ? native.utf8WriteInto : null;
  var nativeLatin1WriteInto =
    typeof native.latin1WriteInto === 'function' ? native.latin1WriteInto : null;
  var nativeLatin1Encode = typeof native.latin1Encode === 'function' ? native.latin1Encode : null;
  var nativeLatin1Decode = typeof native.latin1Decode === 'function' ? native.latin1Decode : null;
  var nativeAsciiDecode = typeof native.asciiDecode === 'function' ? native.asciiDecode : null;
  var nativeUtf16leEncode =
    typeof native.utf16leEncode === 'function' ? native.utf16leEncode : null;
  var nativeUtf16leDecode =
    typeof native.utf16leDecode === 'function' ? native.utf16leDecode : null;
  var nativeUtf16leWriteInto =
    typeof native.utf16leWriteInto === 'function' ? native.utf16leWriteInto : null;
  var NATIVE_BYTEOP_MIN = 64; // compare / indexOf: stay in JS below this
  // Codecs: cross to native at 32 bytes (crossover ~16–32 on Lava; 32 leaves
  // headroom and keeps the 1 KiB microbench on the native path). For utf16le the
  // gate is on *byte* length of the buffer (decode) or *code-unit* length (encode).
  var NATIVE_CODEC_MIN = 32;

  // --- small-input JS codec fallbacks (used below NATIVE_CODEC_MIN) -----------
  var HEX_TABLE = new Array(256);
  var HEX_VAL = new Int8Array(128);
  (function initHexTables() {
    var digits = '0123456789abcdef';
    var i;
    for (i = 0; i < 256; i++) HEX_TABLE[i] = digits[i >> 4] + digits[i & 15];
    for (i = 0; i < 128; i++) HEX_VAL[i] = -1;
    for (i = 0; i < 10; i++) HEX_VAL[48 + i] = i; // '0'-'9'
    for (i = 0; i < 6; i++) {
      HEX_VAL[97 + i] = 10 + i; // 'a'-'f'
      HEX_VAL[65 + i] = 10 + i; // 'A'-'F'
    }
  })();

  function hexEncodeJs(bytes) {
    var n = bytes.length;
    if (n === 0) return '';
    var parts = new Array(n);
    for (var i = 0; i < n; i++) parts[i] = HEX_TABLE[bytes[i]];
    return parts.join('');
  }

  function hexDecodeJs(str) {
    str = String(str);
    var len = str.length;
    var out = new Uint8Array(len >>> 1);
    var n = 0;
    for (var i = 0; i + 1 < len; i += 2) {
      var c0 = str.charCodeAt(i);
      var c1 = str.charCodeAt(i + 1);
      if (c0 > 127 || c1 > 127) break;
      var hi = HEX_VAL[c0];
      var lo = HEX_VAL[c1];
      if (hi < 0 || lo < 0) break;
      out[n++] = (hi << 4) | lo;
    }
    return n === out.length ? out : out.subarray(0, n);
  }

  var B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64EncodeJs(bytes) {
    var n = bytes.length;
    if (n === 0) return '';
    var out = '';
    var i = 0;
    for (; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        B64_ALPHABET[(v >> 18) & 63] +
        B64_ALPHABET[(v >> 12) & 63] +
        B64_ALPHABET[(v >> 6) & 63] +
        B64_ALPHABET[v & 63];
    }
    if (n - i === 1) {
      v = bytes[i] << 16;
      out += B64_ALPHABET[(v >> 18) & 63] + B64_ALPHABET[(v >> 12) & 63] + '==';
    } else if (n - i === 2) {
      v = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out +=
        B64_ALPHABET[(v >> 18) & 63] +
        B64_ALPHABET[(v >> 12) & 63] +
        B64_ALPHABET[(v >> 6) & 63] +
        '=';
    }
    return out;
  }

  var textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

  function latin1EncodeJs(str) {
    str = String(str);
    var a = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  }

  function latin1DecodeJs(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function asciiDecodeJs(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
    return s;
  }

  // Size-gated wrappers: native bulk work past NATIVE_CODEC_MIN, JS below.
  function utf8Encode(str) {
    str = String(str);
    if (textEncoder !== null && str.length < NATIVE_CODEC_MIN) return textEncoder.encode(str);
    return native.utf8Encode(str);
  }

  function utf8Decode(bytes) {
    if (textDecoder !== null && bytes.length < NATIVE_CODEC_MIN) return textDecoder.decode(bytes);
    return native.utf8Decode(bytes);
  }

  function hexEncode(bytes) {
    if (bytes.length < NATIVE_CODEC_MIN) return hexEncodeJs(bytes);
    return native.hexEncode(bytes);
  }

  function hexDecode(str) {
    str = String(str);
    if (str.length < NATIVE_CODEC_MIN * 2) return hexDecodeJs(str);
    return native.hexDecode(str);
  }

  function base64Encode(bytes) {
    if (bytes.length < NATIVE_CODEC_MIN) return base64EncodeJs(bytes);
    return native.base64Encode(bytes);
  }

  function latin1Encode(str) {
    str = String(str);
    if (nativeLatin1Encode === null || str.length < NATIVE_CODEC_MIN) return latin1EncodeJs(str);
    return nativeLatin1Encode(str);
  }

  function latin1Decode(bytes) {
    if (nativeLatin1Decode === null || bytes.length < NATIVE_CODEC_MIN)
      return latin1DecodeJs(bytes);
    return nativeLatin1Decode(bytes);
  }

  function asciiDecode(bytes) {
    if (nativeAsciiDecode === null || bytes.length < NATIVE_CODEC_MIN) return asciiDecodeJs(bytes);
    return nativeAsciiDecode(bytes);
  }

  function utf16leEncodeJs(str) {
    str = String(str);
    var out = new Uint8Array(str.length * 2);
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      out[i * 2] = code & 0xff;
      out[i * 2 + 1] = code >>> 8;
    }
    return out;
  }

  function utf16leDecodeJs(bytes) {
    var out = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }

  function utf16leEncode(str) {
    str = String(str);
    // Gate on code units (≈ half the byte output); tiny strings stay in JS.
    if (nativeUtf16leEncode === null || str.length < NATIVE_CODEC_MIN) return utf16leEncodeJs(str);
    return nativeUtf16leEncode(str);
  }

  function utf16leDecode(bytes) {
    // Gate on byte length; pure-JS concat is catastrophic above a few dozen bytes.
    if (nativeUtf16leDecode === null || bytes.length < NATIVE_CODEC_MIN)
      return utf16leDecodeJs(bytes);
    return nativeUtf16leDecode(bytes);
  }

  // node:buffer length limits. MAX_STRING_LENGTH is V8's string cap. MAX_LENGTH is
  // the largest buffer this runtime will allocate: native computes the practical
  // JavaScriptCore ceiling for the platform (overridable via LAVA_MAX_BUFFER_BYTES;
  // see max_buffer_alloc_bytes in buffer.odin) and passes it as maxAllocBytes.
  // JSC can abort the process on an allocation it cannot satisfy, so MAX_LENGTH is a
  // hard, *enforced* ceiling here. The default (4 GiB on 64-bit) matches Bun, the
  // other JSC-based runtime, which likewise reports kMaxLength === 4294967296 rather
  // than the Number.MAX_SAFE_INTEGER that V8/Node advertise on 64-bit — this is the
  // JSC-family convention, not a lava-only choice. Requests past it throw a catchable
  // RangeError before JSC is asked to allocate; packages read MAX_LENGTH to size work.
  var MAX_SAFE = 9007199254740991; // Number.MAX_SAFE_INTEGER
  var MAX_ALLOC_BYTES =
    native && typeof native.maxAllocBytes === 'number' && native.maxAllocBytes > 0
      ? Math.min(native.maxAllocBytes, MAX_SAFE)
      : 4294967296;
  var K_MAX_LENGTH = MAX_ALLOC_BYTES;
  var K_STRING_MAX_LENGTH = 536870888;
  var inspectMaxBytes = 50;

  // Node renders Buffers through util.inspect's custom hook; matching the
  // well-known symbol lets console.log/util.inspect print "<Buffer ..>" instead
  // of the generic object dump. internal/util.js and console.js look it up too.
  var customInspectSymbol =
    typeof Symbol !== 'undefined' && Symbol.for ? Symbol.for('nodejs.util.inspect.custom') : null;

  // --- Node-style coded errors --------------------------------------------
  // Real packages branch on err.code (and occasionally parse the message), so
  // we reproduce Node's codes and message shapes rather than throwing generic
  // Error objects.
  function describeType(value) {
    if (value === null) return 'null';
    var t = typeof value;
    if (t === 'undefined') return 'undefined';
    if (t === 'string') {
      var s = value.length > 28 ? value.slice(0, 25) + '...' : value;
      return "type string ('" + s + "')";
    }
    if (t === 'number' || t === 'boolean') return 'type ' + t + ' (' + value + ')';
    if (t === 'bigint') return 'type bigint (' + value + 'n)';
    if (t === 'symbol') return 'type symbol (' + value.toString() + ')';
    if (t === 'function') return 'function ' + (value.name || '(anonymous)');
    var ctor = value.constructor && value.constructor.name;
    return 'an instance of ' + (ctor || 'Object');
  }

  // Mirror Node's addNumericSeparator: group integer digits with underscores so
  // large out-of-range values read the same ("9_007_199_254_740_991").
  function numericSeparator(value) {
    var str;
    if (typeof value === 'bigint') str = value.toString();
    else if (typeof value !== 'number') return String(value);
    else if (!isFinite(value) || Math.floor(value) !== value) return String(value);
    else str = String(value);
    var neg = str.charAt(0) === '-';
    if (neg) str = str.slice(1);
    var out = '';
    var i = str.length;
    for (; i > 3; i -= 3) out = '_' + str.slice(i - 3, i) + out;
    return (neg ? '-' : '') + str.slice(0, i) + out;
  }

  function errInvalidArgType(name, expected, actual) {
    var e = new TypeError(
      'The "' + name + '" argument must be ' + expected + '. Received ' + describeType(actual),
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  function errInvalidFromArg(value) {
    var e = new TypeError(
      'The first argument must be of type string or an instance of Buffer, ArrayBuffer, ' +
        'or Array or an Array-like Object. Received ' +
        describeType(value),
    );
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  function errOutOfRange(name, range, received) {
    // Node only digit-groups a received value whose magnitude exceeds 2**32
    // (writeUInt16BE(65536) -> "65536", but writeUIntLE(2**48,..) ->
    // "281_474_976_710_656"); a bigint additionally gets a trailing "n"
    // (writeBigUInt64LE(2n**64n) -> "18_446_744_073_709_551_616n").
    var rendered;
    if (typeof received === 'bigint') {
      var bigWide = received > BigInt('4294967296') || received < -BigInt('4294967296');
      rendered = (bigWide ? numericSeparator(received) : received.toString()) + 'n';
    } else if (typeof received === 'number' && (received > 4294967296 || received < -4294967296)) {
      rendered = numericSeparator(received);
    } else {
      rendered = String(received);
    }
    var e = new RangeError(
      'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + rendered,
    );
    e.code = 'ERR_OUT_OF_RANGE';
    return e;
  }

  // Node throws ERR_INVALID_ARG_VALUE when a fill value cannot be represented in
  // the requested encoding (a non-empty string that decodes to no bytes, or an
  // empty Buffer/Uint8Array). The received value is rendered the way Node does:
  // strings single-quoted, Buffers as "<Buffer ..>".
  function errInvalidArgValue(name, value) {
    var rendered;
    if (typeof value === 'string') rendered = "'" + value + "'";
    else if (value instanceof Uint8Array) rendered = inspectBuffer(value);
    else rendered = describeType(value);
    var e = new TypeError("The argument '" + name + "' is invalid. Received " + rendered);
    e.code = 'ERR_INVALID_ARG_VALUE';
    return e;
  }

  // validateByteLength guards the variable-width accessors (readUIntLE/BE,
  // readIntLE/BE, writeUIntLE/BE, writeIntLE/BE). Node requires an integer in
  // 1..6: a missing/non-numeric byteLength is ERR_INVALID_ARG_TYPE, a fractional
  // one is ERR_OUT_OF_RANGE ("an integer"), and 0 / >6 is ERR_OUT_OF_RANGE
  // (">= 1 and <= 6").
  function validateByteLength(byteLength) {
    if (typeof byteLength !== 'number')
      throw errInvalidArgType('byteLength', 'of type number', byteLength);
    if (Math.floor(byteLength) !== byteLength)
      throw errOutOfRange('byteLength', 'an integer', byteLength);
    if (byteLength < 1 || byteLength > 6)
      throw errOutOfRange('byteLength', '>= 1 and <= 6', byteLength);
  }

  // checkValueInt reproduces Node's checkInt() value-range guard for the integer
  // writers. blMinus1 is Node's internal "byteLength" parameter (the real byte
  // width minus one): when it exceeds 3 the message switches from the plain
  // ">= min and <= max" form to the ">= 0 and < 2 ** N" / signed-power form Node
  // emits for >32-bit writes; a bigint min/max appends the "n" suffix. The store
  // (typed-array element or per-byte) truncates a fractional but in-range value,
  // exactly as Node does — so only an out-of-range value throws here.
  function checkValueInt(value, min, max, blMinus1) {
    if (value > max || value < min) {
      var n = typeof min === 'bigint' ? 'n' : '';
      var range;
      if (blMinus1 > 3) {
        var bits = (blMinus1 + 1) * 8;
        if (min === 0 || min === BigInt(0)) {
          range = '>= 0' + n + ' and < 2' + n + ' ** ' + bits + n;
        } else {
          range =
            '>= -(2' + n + ' ** ' + (bits - 1) + n + ') and < 2' + n + ' ** ' + (bits - 1) + n;
        }
      } else {
        range = '>= ' + min + n + ' and <= ' + max + n;
      }
      throw errOutOfRange('value', range, value);
    }
  }

  // validateWriteOffset enforces Node's write()/fill() offset contract: an
  // integer in [0, max]. Note the "&&" message form — distinct from the "and"
  // form checkBounds() uses for the fixed-width numeric accessors (Node spells
  // these two error sites differently, and packages occasionally match on it).
  function validateWriteOffset(offset, max, name) {
    if (Math.floor(offset) !== offset) throw errOutOfRange(name, 'an integer', offset);
    if (offset < 0 || offset > max) throw errOutOfRange(name, '>= 0 && <= ' + max, offset);
    return offset;
  }

  function errUnknownEncoding(encoding) {
    var e = new TypeError('Unknown encoding: ' + encoding);
    e.code = 'ERR_UNKNOWN_ENCODING';
    return e;
  }

  function errBufferSize(bits) {
    var e = new RangeError('Buffer size must be a multiple of ' + bits + '-bits');
    e.code = 'ERR_INVALID_BUFFER_SIZE';
    return e;
  }

  // assertSize guards Buffer.alloc/allocUnsafe. A negative or non-numeric size
  // throws ERR_OUT_OF_RANGE / ERR_INVALID_ARG_TYPE rather than reaching the
  // Uint8Array constructor as a multi-gigabyte (or NaN) allocation, and a size
  // beyond K_MAX_LENGTH throws rather than aborting JSC. Fractional sizes are
  // allowed — the Uint8Array constructor truncates them, matching Node.
  function assertSize(size) {
    if (typeof size !== 'number') throw errInvalidArgType('size', 'number', size);
    if (!(size >= 0 && size <= K_MAX_LENGTH))
      throw errOutOfRange('size', '>= 0 && <= ' + K_MAX_LENGTH, size);
  }

  function normalizeEncoding(encoding) {
    encoding = (encoding || 'utf8').toLowerCase();
    if (encoding === 'utf-8') return 'utf8';
    if (encoding === 'ucs2' || encoding === 'ucs-2' || encoding === 'utf-16le') return 'utf16le';
    if (encoding === 'binary') return 'latin1';
    return encoding;
  }

  function isEncodingName(encoding) {
    // Match against the raw (lowercased) name and its aliases directly. Going
    // through normalizeEncoding would map the empty string to 'utf8' and wrongly
    // report it as valid; Node rejects '' and unknown names.
    switch (String(encoding).toLowerCase()) {
      case 'utf8':
      case 'utf-8':
      case 'utf16le':
      case 'utf-16le':
      case 'ucs2':
      case 'ucs-2':
      case 'latin1':
      case 'binary':
      case 'ascii':
      case 'hex':
      case 'base64':
      case 'base64url':
        return true;
    }
    return false;
  }

  function normalizeBase64(str) {
    str = String(str)
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .replaceAll(/[^A-Za-z0-9+/]/g, '');
    if (str.length % 4 === 1) str = str.slice(0, str.length - 1);
    while (str.length % 4 !== 0) str += '=';
    return str;
  }

  function toBase64Url(str) {
    return str.replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '');
  }

  function strToBytes(str, encoding) {
    encoding = normalizeEncoding(encoding);
    if (encoding === 'utf8') return utf8Encode(str);
    if (encoding === 'utf16le') return utf16leEncode(str);
    if (encoding === 'hex') return hexDecode(str);
    if (encoding === 'base64' || encoding === 'base64url') {
      var norm = normalizeBase64(str);
      // Always native after JS normalization (padding / alphabet cleanup); the
      // normalize step dominates tiny inputs, so a second size-gate is not useful.
      return norm ? native.base64Decode(norm) : new Uint8Array(0);
    }
    // ascii and latin1 share the encode path (low byte of each code unit).
    if (encoding === 'ascii' || encoding === 'latin1') return latin1Encode(str);
    throw errUnknownEncoding(encoding);
  }

  function bytesToString(bytes, encoding) {
    encoding = normalizeEncoding(encoding);
    if (encoding === 'utf8') return utf8Decode(bytes);
    if (encoding === 'utf16le') return utf16leDecode(bytes);
    if (encoding === 'hex') return hexEncode(bytes);
    if (encoding === 'base64') return base64Encode(bytes);
    if (encoding === 'base64url') return toBase64Url(base64Encode(bytes));
    if (encoding === 'latin1') return latin1Decode(bytes);
    if (encoding === 'ascii') return asciiDecode(bytes);
    throw errUnknownEncoding(encoding);
  }

  function toInteger(value, fallback) {
    if (value === undefined) return fallback;
    value = Number(value);
    if (!isFinite(value) || value === 0) return 0;
    return value < 0 ? Math.ceil(value) : Math.floor(value);
  }

  function clampIndex(value, length, fallback) {
    value = toInteger(value, fallback);
    if (value < 0) value += length;
    if (value < 0) return 0;
    if (value > length) return length;
    return value;
  }

  function errBufferOutOfBounds() {
    var e = new RangeError('Attempt to access memory outside buffer bounds');
    e.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
    return e;
  }

  function checkBounds(buf, offset, byteLength) {
    if (offset === undefined) offset = 0;
    // Node validates the offset (validateNumber + integer check) before testing
    // the range, and distinguishes "type doesn't fit at all" (the max valid
    // offset is negative -> ERR_BUFFER_OUT_OF_BOUNDS) from a plain out-of-range
    // offset (ERR_OUT_OF_RANGE).
    if (typeof offset !== 'number') throw errInvalidArgType('offset', 'number', offset);
    if (Math.floor(offset) !== offset) throw errOutOfRange('offset', 'an integer', offset);
    var max = buf.length - byteLength;
    if (max < 0) throw errBufferOutOfBounds();
    if (offset < 0 || offset > max) throw errOutOfRange('offset', '>= 0 and <= ' + max, offset);
    return offset;
  }

  function validateRange(value, max, name) {
    value = toInteger(value, 0);
    if (value < 0 || value > max) throw new RangeError(name + ' is out of range');
    return value;
  }

  // One cached DataView per Buffer rather than a fresh allocation on every numeric
  // read/write. A Buffer's (buffer, byteOffset, byteLength) is fixed for its
  // lifetime, so the view stays valid; the WeakMap keeps no Buffer alive and adds
  // no observable own property. This removes the per-accessor allocation that drove
  // GC pressure in tight binary-parsing loops — without the correctness traps of
  // hand-rolled bitwise math (readUInt32 would need >>>0, signed reads need
  // sign-extension, and floats can't be reinterpreted bitwise in JS at all).
  var dataViewCache = new WeakMap();
  function viewOf(buf) {
    var dv = dataViewCache.get(buf);
    if (dv === undefined) {
      dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      dataViewCache.set(buf, dv);
    }
    return dv;
  }

  function compareBytes(a, b) {
    if (nativeCompare !== null && (a.length >= NATIVE_BYTEOP_MIN || b.length >= NATIVE_BYTEOP_MIN))
      return nativeCompare(a, b);
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    if (a.length < b.length) return -1;
    if (a.length > b.length) return 1;
    return 0;
  }

  function toSearchBytes(value, encoding) {
    if (typeof value === 'number') return new Uint8Array([value & 0xff]);
    if (typeof value === 'string') return strToBytes(value, encoding || 'utf8');
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new TypeError('value must be string, number, Buffer, or Uint8Array');
  }

  function bidirectionalIndexOf(buf, value, byteOffset, encoding, forward) {
    var needle = toSearchBytes(value, encoding);
    if (needle.length === 0)
      return forward
        ? clampIndex(byteOffset, buf.length, 0)
        : Math.min(clampIndex(byteOffset, buf.length, buf.length), buf.length);
    var start = clampIndex(byteOffset, buf.length, forward ? 0 : buf.length);
    // Native byte search (Rabin-Karp) for large buffers; the empty-needle and
    // clamping rules above stay in JS, so native only sees a non-empty needle.
    if (nativeIndexOf !== null && buf.length >= NATIVE_BYTEOP_MIN && needle.length <= buf.length) {
      return nativeIndexOf(buf, needle, start, forward);
    }
    if (forward) {
      for (var i = start; i <= buf.length - needle.length; i++) {
        var ok = true;
        for (var j = 0; j < needle.length; j++)
          if (buf[i + j] !== needle[j]) {
            ok = false;
            break;
          }
        if (ok) return i;
      }
    } else {
      for (var k = Math.min(start, buf.length - needle.length); k >= 0; k--) {
        var match = true;
        for (var m = 0; m < needle.length; m++)
          if (buf[k + m] !== needle[m]) {
            match = false;
            break;
          }
        if (match) return k;
      }
    }
    return -1;
  }

  // Coerce + range-check a fixed-width integer write value the way Node does
  // (value before bounds): returns the coerced Number so the caller can store it
  // through a DataView/typed-array slot, which truncates a fractional in-range
  // value exactly as Node's writer does.
  function checkFixed(value, min, max, blMinus1) {
    value = +value;
    checkValueInt(value, min, max, blMinus1);
    return value;
  }

  function readUInt(buf, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    offset = checkBounds(buf, offset, byteLength);
    var value = 0;
    if (littleEndian) {
      for (var i = byteLength - 1; i >= 0; i--) value = value * 0x100 + buf[offset + i];
    } else {
      for (var j = 0; j < byteLength; j++) value = value * 0x100 + buf[offset + j];
    }
    return value;
  }

  function readInt(buf, offset, byteLength, littleEndian) {
    // readUInt validates byteLength + bounds first, so the pow below only runs
    // for a valid 1..6 width.
    var value = readUInt(buf, offset, byteLength, littleEndian);
    var sign = Math.pow(2, byteLength * 8 - 1);
    var full = sign * 2;
    return value >= sign ? value - full : value;
  }

  function writeUInt(buf, value, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    // 2 ** (8 * byteLength) - 1 is exact for byteLength <= 6 (<= 2**48 - 1, well
    // within MAX_SAFE_INTEGER). Range-check the raw value before flooring so a
    // fractional but over-range value (e.g. 65535.5 into 2 bytes) still throws.
    var max = Math.pow(2, 8 * byteLength) - 1;
    value = +value;
    checkValueInt(value, 0, max, byteLength - 1);
    offset = checkBounds(buf, offset, byteLength);
    value = Math.floor(value);
    for (var i = 0; i < byteLength; i++) {
      var index = littleEndian ? offset + i : offset + byteLength - 1 - i;
      buf[index] = value & 0xff; // ToInt32 preserves the low byte for value < 2**48
      value = Math.floor(value / 0x100);
    }
    return offset + byteLength;
  }

  function writeInt(buf, value, offset, byteLength, littleEndian) {
    validateByteLength(byteLength);
    var limit = Math.pow(2, 8 * byteLength - 1); // exact for byteLength <= 6
    value = +value;
    checkValueInt(value, -limit, limit - 1, byteLength - 1);
    offset = checkBounds(buf, offset, byteLength);
    value = Math.floor(value);
    if (value < 0) value += Math.pow(2, byteLength * 8);
    for (var i = 0; i < byteLength; i++) {
      var index = littleEndian ? offset + i : offset + byteLength - 1 - i;
      buf[index] = value & 0xff;
      value = Math.floor(value / 0x100);
    }
    return offset + byteLength;
  }

  function readBigUInt(buf, offset, littleEndian) {
    offset = checkBounds(buf, offset, 8);
    var value = BigInt(0);
    if (littleEndian) {
      for (var i = 7; i >= 0; i--) value = (value << BigInt(8)) + BigInt(buf[offset + i]);
    } else {
      for (var j = 0; j < 8; j++) value = (value << BigInt(8)) + BigInt(buf[offset + j]);
    }
    return value;
  }

  function readBigInt(buf, offset, littleEndian) {
    var value = readBigUInt(buf, offset, littleEndian);
    var sign = BigInt(1) << BigInt(63);
    return value >= sign ? value - (BigInt(1) << BigInt(64)) : value;
  }

  function writeBigUInt(buf, value, offset, littleEndian) {
    value = BigInt(value);
    // checkValueInt with blMinus1 = 7 yields Node's ">= 0n and < 2n ** 64n".
    checkValueInt(value, BigInt(0), (BigInt(1) << BigInt(64)) - BigInt(1), 7);
    offset = checkBounds(buf, offset, 8);
    for (var i = 0; i < 8; i++) {
      var index = littleEndian ? offset + i : offset + 7 - i;
      buf[index] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
    }
    return offset + 8;
  }

  function writeBigInt(buf, value, offset, littleEndian) {
    value = BigInt(value);
    var limit = BigInt(1) << BigInt(63);
    checkValueInt(value, -limit, limit - BigInt(1), 7); // ">= -(2n ** 63n) and < 2n ** 63n"
    offset = checkBounds(buf, offset, 8);
    if (value < 0) value += BigInt(1) << BigInt(64); // two's-complement, then write the bytes
    for (var i = 0; i < 8; i++) {
      var index = littleEndian ? offset + i : offset + 7 - i;
      buf[index] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
    }
    return offset + 8;
  }

  class Buffer extends Uint8Array {
    constructor(arg, byteOffset, length) {
      // The deprecated `new Buffer(string[, encoding])` form delegates to
      // Buffer.from (Node keeps it working, just with a DEP0005 warning). Without
      // this, `super(string, …)` would mis-encode the string — `new Buffer('abc')`
      // yielded an empty buffer and `new Buffer('616263','hex')` random garbage. A
      // derived constructor may return an object instead of calling super(), and
      // Buffer.from for a string allocates a fresh (pooled) Buffer with no
      // recursion (its inner alloc uses the numeric/ArrayBuffer-view forms). The
      // array / Buffer / ArrayBuffer-view / size forms are equivalent to the
      // Uint8Array super() call, so they pass straight through (with the ceiling
      // check below). `new Buffer(size)` is zero-filled, matching Buffer.alloc.
      if (typeof arg === 'string') {
        return Buffer.from(arg, byteOffset);
      }
      // A numeric first argument is the size form (new Buffer(size)). Validate it
      // against the practical ceiling *before* super() so an oversized request —
      // reached through any route (alloc/allocUnsafe, fromArrayLike, concat) —
      // throws a catchable RangeError instead of aborting the process inside JSC.
      // The ArrayBuffer/SharedArrayBuffer view form (object first arg) shares
      // existing memory and allocates nothing, so it is passed straight through.
      if (typeof arg === 'number' && arg > K_MAX_LENGTH) {
        throw errOutOfRange('size', '>= 0 && <= ' + K_MAX_LENGTH, arg);
      }
      super(arg, byteOffset, length);
    }

    toString(encoding, start, end) {
      // Node's slowToString clamps a negative start to 0 (it does NOT wrap like
      // slice/subarray), and a start past the end yields ''. end clamps to the
      // length. Use int32 truncation (|0) on in-range values, matching Node.
      var len = this.length;
      if (start <= 0) start = 0;
      else if (start >= len) return '';
      else start |= 0;
      if (end === undefined || end > len) end = len;
      else end |= 0;
      if (end <= start) return '';
      return bytesToString(this.subarray(start, end), encoding || 'utf8');
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      // Each index is coerced with toInteger (so a fractional index is floored,
      // NOT rejected) and a negative one throws ERR_OUT_OF_RANGE — a negative
      // offset is an error, not an index from the end. The upper bounds are
      // clamped rather than thrown: a targetStart past the target, or
      // sourceStart >= sourceEnd, copies nothing.
      if (!(target instanceof Uint8Array))
        throw errInvalidArgType('target', 'an instance of Buffer or Uint8Array', target);
      if (targetStart === undefined) {
        targetStart = 0;
      } else {
        targetStart = toInteger(targetStart, 0);
        if (targetStart < 0) throw errOutOfRange('targetStart', '>= 0', targetStart);
      }
      if (sourceStart === undefined) {
        sourceStart = 0;
      } else {
        sourceStart = toInteger(sourceStart, 0);
        if (sourceStart < 0 || sourceStart > this.length)
          throw errOutOfRange('sourceStart', '>= 0 && <= ' + this.length, sourceStart);
      }
      if (sourceEnd === undefined) {
        sourceEnd = this.length;
      } else {
        sourceEnd = toInteger(sourceEnd, 0);
        if (sourceEnd < 0) throw errOutOfRange('sourceEnd', '>= 0', sourceEnd);
      }
      if (sourceEnd > this.length) sourceEnd = this.length;
      if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;
      var len = Math.min(sourceEnd - sourceStart, target.length - targetStart);
      target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
      return len;
    }

    write(string, offset, length, encoding) {
      if (offset === undefined) {
        // write(string)
        offset = 0;
        length = this.length;
      } else if (typeof offset === 'string') {
        // write(string, encoding)
        encoding = offset;
        offset = 0;
        length = this.length;
      } else {
        // write(string, offset[, length][, encoding]). Node validates offset as
        // an integer in [0, length] and throws ERR_OUT_OF_RANGE otherwise; it no
        // longer wraps a negative offset from the end the way clampIndex did.
        offset = validateWriteOffset(+offset, this.length, 'offset');
        if (typeof length === 'string') {
          encoding = length;
          length = undefined;
        }
      }
      var enc = normalizeEncoding(encoding || 'utf8');
      var remaining = this.length - offset;
      // UTF-8 fast path: encode straight into this buffer — no throwaway
      // intermediate Uint8Array, no JS copy loop. maxLength is capped exactly as
      // the fallback caps `length` below, so the byte count is identical (the
      // native side truncates to it, possibly mid-character, like Node).
      if (enc === 'utf8' && nativeUtf8WriteInto !== null) {
        var max = length === undefined ? remaining : toInteger(length, 0);
        if (max > remaining) max = remaining;
        if (max <= 0) return 0;
        return nativeUtf8WriteInto(this, String(string), offset, max);
      }
      // latin1/ascii: one output byte per code unit — write in place like utf8WriteInto.
      if ((enc === 'latin1' || enc === 'ascii') && nativeLatin1WriteInto !== null) {
        var maxL = length === undefined ? remaining : toInteger(length, 0);
        if (maxL > remaining) maxL = remaining;
        if (maxL <= 0) return 0;
        return nativeLatin1WriteInto(this, String(string), offset, maxL);
      }
      if (enc === 'utf16le' && nativeUtf16leWriteInto !== null) {
        var maxU = length === undefined ? remaining : toInteger(length, 0);
        if (maxU > remaining) maxU = remaining;
        if (maxU <= 0) return 0;
        return nativeUtf16leWriteInto(this, String(string), offset, maxU);
      }
      var bytes = strToBytes(String(string), enc);
      length =
        length === undefined
          ? bytes.length
          : Math.min(toInteger(length, bytes.length), bytes.length);
      length = Math.min(length, remaining);
      if (length < 0) length = 0;
      if (length > 0) this.set(bytes.subarray(0, length), offset);
      return length;
    }

    slice(start, end) {
      return this.subarray(start, end);
    }

    subarray(start, end) {
      var sub = Uint8Array.prototype.subarray.call(this, start, end);
      return new Buffer(sub.buffer, sub.byteOffset, sub.length);
    }

    equals(other) {
      if (!(other instanceof Uint8Array) || this.length !== other.length) return false;
      return compareBytes(this, other) === 0;
    }

    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array))
        throw new TypeError('target must be a Buffer or Uint8Array');
      targetStart = validateRange(targetStart, K_MAX_LENGTH, 'targetStart');
      targetEnd = validateRange(
        targetEnd === undefined ? target.length : targetEnd,
        target.length,
        'targetEnd',
      );
      sourceStart = validateRange(sourceStart, K_MAX_LENGTH, 'sourceStart');
      sourceEnd = validateRange(
        sourceEnd === undefined ? this.length : sourceEnd,
        this.length,
        'sourceEnd',
      );
      if (sourceStart >= sourceEnd && targetStart >= targetEnd) return 0;
      if (sourceStart >= sourceEnd) return -1;
      if (targetStart >= targetEnd) return 1;
      return compareBytes(
        this.subarray(sourceStart, sourceEnd),
        target.subarray(targetStart, targetEnd),
      );
    }

    fill(value, start, end, encoding) {
      if (typeof start === 'string') {
        encoding = start;
        start = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        encoding = end;
        end = this.length;
      }
      // Node validates start (which it names "offset") and end as integers and
      // throws ERR_OUT_OF_RANGE for negatives. start has no enforced upper bound
      // (a start past the end fills nothing); end must be within the buffer.
      // Previously both ran through clampIndex, so negatives wrapped from the end.
      if (start === undefined) start = 0;
      else start = validateWriteOffset(+start, K_MAX_LENGTH, 'offset');
      if (end === undefined) end = this.length;
      else end = validateWriteOffset(+end, this.length, 'end');
      // Resolve the repeating fill pattern. A number/boolean masks to one byte; a
      // Uint8Array is used as-is. A string is encoded with `encoding` (an unknown
      // encoding throws ERR_UNKNOWN_ENCODING via strToBytes). The empty string
      // fills with a single 0 byte, but any other source that yields zero bytes
      // (bad hex, an empty Buffer) is ERR_INVALID_ARG_VALUE.
      var bytes;
      if (typeof value === 'number') {
        bytes = new Uint8Array([value & 0xff]);
      } else if (typeof value === 'boolean') {
        bytes = new Uint8Array([value ? 1 : 0]);
      } else if (value instanceof Uint8Array) {
        if (value.length === 0) throw errInvalidArgValue('value', value);
        bytes = value;
      } else {
        var str = String(value);
        bytes = strToBytes(str, encoding || 'utf8');
        if (bytes.length === 0) {
          if (str.length !== 0) throw errInvalidArgValue('value', value);
          bytes = new Uint8Array([0]); // fill('') zero-fills the range
        }
      }
      if (end <= start) return this;
      for (var i = start; i < end; i++) this[i] = bytes[(i - start) % bytes.length];
      return this;
    }

    includes(value, byteOffset, encoding) {
      return this.indexOf(value, byteOffset, encoding) !== -1;
    }

    indexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, true);
    }

    lastIndexOf(value, byteOffset, encoding) {
      return bidirectionalIndexOf(this, value, byteOffset, encoding, false);
    }

    swap16() {
      if (this.length % 2 !== 0) throw errBufferSize(16);
      for (var i = 0; i < this.length; i += 2) {
        var a = this[i];
        this[i] = this[i + 1];
        this[i + 1] = a;
      }
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) throw errBufferSize(32);
      for (var i = 0; i < this.length; i += 4) {
        var a = this[i],
          b = this[i + 1];
        this[i] = this[i + 3];
        this[i + 1] = this[i + 2];
        this[i + 2] = b;
        this[i + 3] = a;
      }
      return this;
    }

    swap64() {
      if (this.length % 8 !== 0) throw errBufferSize(64);
      for (var i = 0; i < this.length; i += 8) {
        for (var j = 0; j < 4; j++) {
          var a = this[i + j];
          this[i + j] = this[i + 7 - j];
          this[i + 7 - j] = a;
        }
      }
      return this;
    }

    toJSON() {
      return { type: 'Buffer', data: Array.prototype.slice.call(this) };
    }
  }

  var p = Buffer.prototype;

  // Shared renderer for the legacy .inspect() method and the util.inspect custom
  // hook. Caps the dump at INSPECT_MAX_BYTES, appending "... N more byte(s)" like
  // Node when the buffer is longer.
  function inspectBuffer(buf) {
    var max = inspectMaxBytes;
    var shown = buf.length > max ? max : buf.length;
    var hex = Buffer.prototype.toString
      .call(buf, 'hex', 0, shown)
      .replaceAll(/(.{2})/g, '$1 ')
      .trim();
    var remaining = buf.length - max;
    if (remaining > 0)
      hex +=
        (hex.length > 0 ? ' ' : '') +
        '... ' +
        remaining +
        ' more byte' +
        (remaining > 1 ? 's' : '');
    return '<Buffer ' + hex + '>';
  }

  p.inspect = function () {
    return inspectBuffer(this);
  };
  if (customInspectSymbol) {
    // Non-enumerable + symbol-keyed, so it stays off Object.getOwnPropertyNames
    // (the API-surface probe) exactly as in Node.
    Object.defineProperty(p, customInspectSymbol, {
      value: function () {
        return inspectBuffer(this);
      },
      writable: true,
      configurable: true,
    });
  }
  p.toLocaleString = p.toString;
  p.utf8Slice = function (start, end) {
    return this.toString('utf8', start, end);
  };
  p.hexSlice = function (start, end) {
    return this.toString('hex', start, end);
  };
  p.asciiSlice = function (start, end) {
    return this.toString('ascii', start, end);
  };
  p.latin1Slice = function (start, end) {
    return this.toString('latin1', start, end);
  };
  p.base64Slice = function (start, end) {
    return this.toString('base64', start, end);
  };
  p.base64urlSlice = function (start, end) {
    return this.toString('base64url', start, end);
  };
  p.ucs2Slice = function (start, end) {
    return this.toString('utf16le', start, end);
  };
  p.utf8Write = function (string, offset, length) {
    return this.write(string, offset, length, 'utf8');
  };
  p.hexWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'hex');
  };
  p.asciiWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'ascii');
  };
  p.latin1Write = function (string, offset, length) {
    return this.write(string, offset, length, 'latin1');
  };
  p.base64Write = function (string, offset, length) {
    return this.write(string, offset, length, 'base64');
  };
  p.base64urlWrite = function (string, offset, length) {
    return this.write(string, offset, length, 'base64url');
  };
  p.ucs2Write = function (string, offset, length) {
    return this.write(string, offset, length, 'utf16le');
  };
  p.readUInt8 = p.readUint8 = function (offset) {
    offset = checkBounds(this, offset, 1);
    return this[offset];
  };
  p.readInt8 = function (offset) {
    var v = this.readUInt8(offset);
    return v & 0x80 ? v - 0x100 : v;
  };
  p.readUIntLE = p.readUintLE = function (offset, byteLength) {
    return readUInt(this, offset, byteLength, true);
  };
  p.readUIntBE = p.readUintBE = function (offset, byteLength) {
    return readUInt(this, offset, byteLength, false);
  };
  p.readIntLE = function (offset, byteLength) {
    return readInt(this, offset, byteLength, true);
  };
  p.readIntBE = function (offset, byteLength) {
    return readInt(this, offset, byteLength, false);
  };
  p.readUInt16LE = p.readUint16LE = function (offset) {
    return viewOf(this).getUint16(checkBounds(this, offset, 2), true);
  };
  p.readUInt16BE = p.readUint16BE = function (offset) {
    return viewOf(this).getUint16(checkBounds(this, offset, 2), false);
  };
  p.readUInt32LE = p.readUint32LE = function (offset) {
    return viewOf(this).getUint32(checkBounds(this, offset, 4), true);
  };
  p.readUInt32BE = p.readUint32BE = function (offset) {
    return viewOf(this).getUint32(checkBounds(this, offset, 4), false);
  };
  p.readInt16LE = function (offset) {
    return viewOf(this).getInt16(checkBounds(this, offset, 2), true);
  };
  p.readInt16BE = function (offset) {
    return viewOf(this).getInt16(checkBounds(this, offset, 2), false);
  };
  p.readInt32LE = function (offset) {
    return viewOf(this).getInt32(checkBounds(this, offset, 4), true);
  };
  p.readInt32BE = function (offset) {
    return viewOf(this).getInt32(checkBounds(this, offset, 4), false);
  };
  p.readFloatLE = function (offset) {
    return viewOf(this).getFloat32(checkBounds(this, offset, 4), true);
  };
  p.readFloatBE = function (offset) {
    return viewOf(this).getFloat32(checkBounds(this, offset, 4), false);
  };
  p.readDoubleLE = function (offset) {
    return viewOf(this).getFloat64(checkBounds(this, offset, 8), true);
  };
  p.readDoubleBE = function (offset) {
    return viewOf(this).getFloat64(checkBounds(this, offset, 8), false);
  };
  if (typeof BigInt === 'function') {
    p.readBigUInt64LE = p.readBigUint64LE = function (offset) {
      return readBigUInt(this, offset, true);
    };
    p.readBigUInt64BE = p.readBigUint64BE = function (offset) {
      return readBigUInt(this, offset, false);
    };
    p.readBigInt64LE = function (offset) {
      return readBigInt(this, offset, true);
    };
    p.readBigInt64BE = function (offset) {
      return readBigInt(this, offset, false);
    };
  }

  p.writeUInt8 = p.writeUint8 = function (value, offset) {
    value = checkFixed(value, 0, 0xff, 0);
    offset = checkBounds(this, offset, 1);
    this[offset] = value; // Uint8 store truncates a fractional in-range value (Node parity)
    return offset + 1;
  };
  p.writeInt8 = function (value, offset) {
    // Distinct signed range: writeInt8(128) must throw, where writeUInt8(128) is fine.
    value = checkFixed(value, -0x80, 0x7f, 0);
    offset = checkBounds(this, offset, 1);
    this[offset] = value; // store wraps a negative to its two's-complement byte
    return offset + 1;
  };
  p.writeUIntLE = p.writeUintLE = function (value, offset, byteLength) {
    return writeUInt(this, value, offset, byteLength, true);
  };
  p.writeUIntBE = p.writeUintBE = function (value, offset, byteLength) {
    return writeUInt(this, value, offset, byteLength, false);
  };
  p.writeIntLE = function (value, offset, byteLength) {
    return writeInt(this, value, offset, byteLength, true);
  };
  p.writeIntBE = function (value, offset, byteLength) {
    return writeInt(this, value, offset, byteLength, false);
  };
  p.writeUInt16LE = p.writeUint16LE = function (value, offset) {
    value = checkFixed(value, 0, 0xffff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, value, true);
    return offset + 2;
  };
  p.writeUInt16BE = p.writeUint16BE = function (value, offset) {
    value = checkFixed(value, 0, 0xffff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, value, false);
    return offset + 2;
  };
  p.writeUInt32LE = p.writeUint32LE = function (value, offset) {
    value = checkFixed(value, 0, 0xffffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, value, true);
    return offset + 4;
  };
  p.writeUInt32BE = p.writeUint32BE = function (value, offset) {
    value = checkFixed(value, 0, 0xffffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, value, false);
    return offset + 4;
  };
  p.writeInt16LE = function (value, offset) {
    value = checkFixed(value, -0x8000, 0x7fff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, value, true);
    return offset + 2;
  };
  p.writeInt16BE = function (value, offset) {
    value = checkFixed(value, -0x8000, 0x7fff, 1);
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, value, false);
    return offset + 2;
  };
  p.writeInt32LE = function (value, offset) {
    value = checkFixed(value, -0x80000000, 0x7fffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, value, true);
    return offset + 4;
  };
  p.writeInt32BE = function (value, offset) {
    value = checkFixed(value, -0x80000000, 0x7fffffff, 3);
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, value, false);
    return offset + 4;
  };
  p.writeFloatLE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setFloat32(offset, Number(value), true);
    return offset + 4;
  };
  p.writeFloatBE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setFloat32(offset, Number(value), false);
    return offset + 4;
  };
  p.writeDoubleLE = function (value, offset) {
    offset = checkBounds(this, offset, 8);
    viewOf(this).setFloat64(offset, Number(value), true);
    return offset + 8;
  };
  p.writeDoubleBE = function (value, offset) {
    offset = checkBounds(this, offset, 8);
    viewOf(this).setFloat64(offset, Number(value), false);
    return offset + 8;
  };
  if (typeof BigInt === 'function') {
    p.writeBigUInt64LE = p.writeBigUint64LE = function (value, offset) {
      return writeBigUInt(this, value, offset, true);
    };
    p.writeBigUInt64BE = p.writeBigUint64BE = function (value, offset) {
      return writeBigUInt(this, value, offset, false);
    };
    p.writeBigInt64LE = function (value, offset) {
      return writeBigInt(this, value, offset, true);
    };
    p.writeBigInt64BE = function (value, offset) {
      return writeBigInt(this, value, offset, false);
    };
  }

  Object.defineProperty(p, 'parent', {
    get: function () {
      return this.buffer;
    },
  });
  Object.defineProperty(p, 'offset', {
    get: function () {
      return this.byteOffset;
    },
  });

  // --- Allocation pool (Node parity) --------------------------------------
  // Node carves small *unsafe* allocations out of a shared poolSize-byte
  // ArrayBuffer, so several small Buffers share one backing store at different
  // byteOffsets (observable via buf.buffer / buf.byteOffset / buf.buffer
  // .byteLength). This state is plain module scope: node:buffer is instantiated
  // once per runtime/context, so the pool is per-runtime and never leaks across
  // isolated runtimes. Pooled bytes are uninitialized — only allocUnsafe and the
  // Buffer.from(...) copy paths (where Node pools) draw from it; Buffer.alloc,
  // allocUnsafeSlow, and SlowBuffer stay on their own backing store (alloc is
  // zero-filled; the allocUnsafeSlow/SlowBuffer paths go through allocUnsafeNoZero).
  var poolBufferSize; // byteLength of the live allocPool (its real size)
  var poolOffset; // next free byte in allocPool
  var allocPool; // shared backing ArrayBuffer

  function createPool() {
    // Size the pool straight from Buffer.poolSize the way Node does — Node builds
    // its pool with `new Uint8Array(Buffer.poolSize)`. Routing through a typed
    // array (rather than `new ArrayBuffer(Buffer.poolSize >>> 0)`) reproduces Node's
    // exact coercion: a fractional poolSize is truncated by ToIndex (8192.7 -> 8192),
    // and a negative or non-finite poolSize throws a catchable RangeError on the
    // (re-)pool — instead of `>>> 0` silently wrapping it (-1 -> a ~4 GiB request,
    // 1e12 -> ~3.5 GiB, 2^32 -> 0). poolBufferSize reads back the realized byteLength
    // so the carve math below uses the true size. One benign divergence remains: for
    // a poolSize large enough to exceed JavaScriptCore's typed-array allocation cap
    // (a few GiB), this throws RangeError where Node (V8's cap is ~2^53) would instead
    // build a multi-gigabyte pool. That is only reachable by deliberately setting
    // poolSize to gigabytes AND forcing a re-pool, and throwing is the safer choice —
    // we never attempt the giant allocation. A failed (re-)pool also leaves the
    // existing allocPool/poolBufferSize intact (they are assigned only on success),
    // so the throw is recoverable.
    allocPool = new Uint8Array(Buffer.poolSize).buffer;
    poolBufferSize = allocPool.byteLength;
    poolOffset = 0;
  }

  // allocUnsafeNoZero(size) backs the *unpooled* unsafe allocations — large
  // Buffer.allocUnsafe, Buffer.allocUnsafeSlow, and SlowBuffer. Node leaves these
  // uninitialized (its allocator skips the zero-fill); a JS `new Buffer(size)`
  // cannot, because every ArrayBuffer is zero-initialized. So we ask the native
  // binding for an uninitialized region and wrap it as a Buffer *view* over the
  // same backing store — no copy, byteOffset 0, buffer sized exactly to `size`.
  // The native call returns null when the binding is unavailable or the allocation
  // fails; we then fall back to a zero-filled own-backing Buffer, which is strictly
  // safe and still throws the RangeError Node throws for an impossible size. The
  // floor + guards keep a fractional/non-finite size off the native path (it stays
  // on `new Buffer(size)`, matching Node's truncation / RangeError exactly).
  function allocUnsafeNoZero(size) {
    size = Math.floor(size);
    if (size <= 0) return new Buffer(0);
    if (nativeAllocUninit && size <= K_MAX_LENGTH) {
      var raw = nativeAllocUninit(size);
      if (raw) return new Buffer(raw.buffer, raw.byteOffset, raw.length);
    }
    return new Buffer(size);
  }

  // Round the next offset up to an 8-byte boundary, matching Node's alignPool();
  // keeps every pooled buffer's byteOffset 8-aligned.
  function alignPool() {
    if (poolOffset & 0x7) poolOffset = (poolOffset | 0x7) + 1;
  }

  // allocate(size) mirrors Node's internal allocate(): sizes strictly below
  // poolSize/2 are served from the shared pool (uninitialized); anything larger
  // (or exactly poolSize/2 — Node's threshold is `< (poolSize >>> 1)`) gets its
  // own backing store via allocUnsafeNoZero (native-uninitialized, like Node). The
  // pool is recreated when the request no longer fits in what remains. Callers that
  // expose the bytes (Buffer.from) overwrite the whole view; allocUnsafe
  // deliberately leaves stale pool / uninitialized bytes visible.
  function allocate(size) {
    if (!(size > 0)) return new Buffer(0); // 0, negative, or NaN
    if (size < Buffer.poolSize >>> 1) {
      size = Math.floor(size);
      if (size === 0) return new Buffer(0);
      if (size > poolBufferSize - poolOffset) createPool();
      var b = new Buffer(allocPool, poolOffset, size);
      poolOffset += size;
      alignPool();
      return b;
    }
    return allocUnsafeNoZero(size); // own store, uninitialized; Infinity -> ctor throws, like Node
  }

  // fromArrayLike copies element values (each coerced to a byte) into a small
  // pooled (or own, for large) Buffer — used for Arrays, generic TypedArrays,
  // and array-like objects. The length goes through a ToLength-style conversion
  // (NaN/negative -> 0, finite fractional floored) so a hostile `{ length: -1 }`
  // cannot wrap to a 4 GiB allocation; Node likewise returns an empty Buffer for
  // those. The loop overwrites every byte, so no stale pool data leaks through.
  function fromArrayLike(obj) {
    var len = Number(obj.length);
    if (!(len > 0)) return new Buffer(0); // 0, negative, or NaN
    len = Math.floor(len); // Infinity stays Infinity -> Buffer ctor throws, like Node
    var b = allocate(len);
    for (var i = 0; i < len; i++) b[i] = obj[i]; // Uint8Array store coerces & masks
    return b;
  }

  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string') {
      var bytes = strToBytes(value, encodingOrOffset);
      var b = allocate(bytes.length); // pooled for small strings, like Node
      b.set(bytes); // overwrites the whole view -> no stale pool bytes
      return b;
    }
    if (value !== null && typeof value === 'object') {
      if (
        value instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
      ) {
        // Shares the backing store (a view), matching Node.
        return new Buffer(value, encodingOrOffset === undefined ? 0 : encodingOrOffset, length);
      }
      // Node consults valueOf() before treating the object as array-like, so a
      // boxed primitive (new String(...)) resolves to its primitive form first.
      if (typeof value.valueOf === 'function') {
        var valueOf = value.valueOf();
        if (
          valueOf != null &&
          valueOf !== value &&
          (typeof valueOf === 'string' || typeof valueOf === 'object')
        ) {
          return Buffer.from(valueOf, encodingOrOffset, length);
        }
      }
      if (ArrayBuffer.isView(value)) {
        // Copy element values (Uint8Array.set masks each to a byte). Pooled for
        // small inputs like Node; set() overwrites the whole view.
        var copy = allocate(value.length);
        copy.set(value);
        return copy;
      }
      if (Array.isArray(value) || typeof value.length === 'number') {
        return fromArrayLike(value);
      }
      // Revive JSON.parse(JSON.stringify(buffer)) -> {type:'Buffer', data:[...]}.
      if (value.type === 'Buffer' && Array.isArray(value.data)) {
        return fromArrayLike(value.data);
      }
      if (typeof value[Symbol.toPrimitive] === 'function') {
        var primitive = value[Symbol.toPrimitive]('string');
        if (typeof primitive === 'string') return Buffer.from(primitive, encodingOrOffset);
      }
    }
    throw errInvalidFromArg(value);
  };

  Buffer.alloc = function (size, fill, encoding) {
    assertSize(size);
    var b = new Buffer(size);
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);
    return b;
  };

  Buffer.allocUnsafe = function (size) {
    assertSize(size);
    return allocate(size); // small sizes share the per-runtime pool
  };

  Buffer.allocUnsafeSlow = function (size) {
    assertSize(size);
    return allocUnsafeNoZero(size); // never pooled — its own uninitialized backing store, like Node
  };

  Buffer.isBuffer = function (b) {
    return b instanceof Buffer;
  };

  Buffer.isEncoding = function (encoding) {
    return typeof encoding === 'string' && isEncodingName(encoding);
  };

  Buffer.byteLength = function (string, encoding) {
    if (typeof string === 'string') {
      // Node treats an unknown/empty encoding here as UTF-8 (unlike from/toString,
      // which throw) and returns the byte length rather than rejecting the label.
      var enc = encoding === undefined || !isEncodingName(encoding) ? 'utf8' : encoding;
      return strToBytes(string, enc).length;
    }
    if (
      ArrayBuffer.isView(string) ||
      string instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && string instanceof SharedArrayBuffer)
    ) {
      return string.byteLength;
    }
    throw errInvalidArgType(
      'string',
      'of type string or an instance of Buffer or ArrayBuffer',
      string,
    );
  };

  Buffer.compare = function (a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array))
      throw new TypeError('Arguments must be Buffers or Uint8Arrays');
    return compareBytes(a, b);
  };

  function assertConcatElement(item, index) {
    if (!(item instanceof Uint8Array))
      throw errInvalidArgType('list[' + index + ']', 'an instance of Buffer or Uint8Array', item);
  }

  Buffer.concat = function (list, totalLength) {
    if (!Array.isArray(list)) throw errInvalidArgType('list', 'an instance of Array', list);
    if (list.length === 0) return new Buffer(0);
    if (totalLength === undefined) {
      totalLength = 0;
      for (var i = 0; i < list.length; i++) {
        assertConcatElement(list[i], i);
        totalLength += list[i].length;
      }
    } else {
      if (typeof totalLength !== 'number') throw errInvalidArgType('length', 'number', totalLength);
      if (Math.floor(totalLength) !== totalLength)
        throw errOutOfRange('length', 'an integer', totalLength);
      if (totalLength < 0 || totalLength > K_MAX_LENGTH)
        throw errOutOfRange('length', '>= 0 && <= ' + K_MAX_LENGTH, totalLength);
    }
    // Pooled like Node: small concat results share the per-runtime pool. The
    // copies below write [0, offset); any tail left when an explicit totalLength
    // exceeds the input data is zero-filled, because pooled memory is otherwise
    // uninitialized (Node fills the gap the same way). Every byte is thus either
    // copied or zeroed, so no stale pool bytes leak through.
    var result = allocate(totalLength);
    var offset = 0;
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      assertConcatElement(item, j);
      if (offset + item.length > totalLength) {
        result.set(item.subarray(0, totalLength - offset), offset);
        offset = totalLength; // buffer is now full; suppress the tail fill below
        break;
      }
      result.set(item, offset);
      offset += item.length;
    }
    if (offset < totalLength) result.fill(0, offset);
    return result;
  };

  Buffer.copyBytesFrom = function (view, offset, length) {
    if (!ArrayBuffer.isView(view)) throw new TypeError('view must be a TypedArray');
    var bpe = view.BYTES_PER_ELEMENT || 1;
    offset = toInteger(offset, 0);
    length = length === undefined ? view.length - offset : toInteger(length, 0);
    var bytes = new Uint8Array(view.buffer, view.byteOffset + offset * bpe, length * bpe);
    return Buffer.from(bytes);
  };

  Buffer.of = function () {
    return Buffer.from(Array.prototype.slice.call(arguments));
  };

  // Default pool size, matching Node >= 26.3 (Node <= 25 and Bun default to
  // 8192). It may be reassigned; kMaxLength stays the JSC-family 4 GiB.
  Buffer.poolSize = 65536;

  // Build the initial pool now that Buffer.poolSize is set. Nothing in this
  // module allocates Buffers during evaluation, so a single eager call is enough
  // (allocate() re-pools on demand thereafter).
  createPool();

  function SlowBuffer(size) {
    assertSize(size);
    return allocUnsafeNoZero(size); // unpooled + uninitialized by definition
  }

  function atob(data) {
    return Buffer.from(String(data), 'base64').toString('latin1');
  }

  function btoa(data) {
    return Buffer.from(String(data), 'latin1').toString('base64');
  }

  function isAscii(input) {
    var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('input must be a Buffer, ArrayBuffer, or TypedArray');
    for (var i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) return false;
    return true;
  }

  function isUtf8(input) {
    var bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array))
      throw new TypeError('input must be a Buffer, ArrayBuffer, or TypedArray');
    // Native strict validator (no allocation) when available; the JS fallback
    // decodes to a string and re-encodes, which agrees on validity but allocates.
    if (nativeIsValidUtf8 !== null) return nativeIsValidUtf8(bytes);
    return Buffer.from(bytesToString(bytes, 'utf8'), 'utf8').equals(Buffer.from(bytes));
  }

  function transcode(source, fromEnc, toEnc) {
    return Buffer.from(Buffer.from(source).toString(fromEnc), toEnc);
  }

  // --- Blob / File (Web platform classes also exported from node:buffer) ----

  // WHATWG "convert line endings to native". Node uses require('os').EOL; Lava has
  // no node:os, so the platform line ending is derived from process.platform (read
  // lazily — process is installed natively and may post-date this module's eval).
  function nativeEol() {
    return globalThis.process && globalThis.process.platform === 'win32' ? '\r\n' : '\n';
  }

  // Returns a part's bytes as an array of Uint8Array chunks (never one giant
  // copy): a Blob part contributes its existing immutable chunks by reference, so
  // nesting Blobs adds no allocation. Only string parts are subject to line-ending
  // conversion; binary parts (Blob, ArrayBuffer, views) are copied verbatim.
  function blobPartToChunks(part, nativeEndings) {
    if (part instanceof Blob) return part._parts; // shared, immutable
    if (part instanceof ArrayBuffer) return [new Uint8Array(part.slice(0))];
    if (ArrayBuffer.isView(part)) {
      return [
        new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength)),
      ];
    }
    var str = String(part);
    // Node converts "\n" and "\r\n" to the native newline but leaves a lone "\r"
    // untouched, i.e. /\r?\n/ rather than every CR.
    if (nativeEndings) str = str.replace(/\r?\n/g, nativeEol());
    return [new Uint8Array(Buffer.from(str, 'utf8'))];
  }

  // Concatenate a Blob's chunks into one contiguous Uint8Array. Only the methods
  // that must yield the whole content (arrayBuffer/bytes/text) call this; the
  // constructor, size, stream, and slice never materialize the full blob.
  function blobJoin(parts, total) {
    var merged = new Uint8Array(total),
      off = 0;
    for (var i = 0; i < parts.length; i++) {
      merged.set(parts[i], off);
      off += parts[i].length;
    }
    return merged;
  }

  function normalizeBlobType(options) {
    if (!options || options.type === undefined) return '';
    var type = String(options.type);
    for (var i = 0; i < type.length; i++) {
      var code = type.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) return ''; // Node drops types with non-printable chars
    }
    return type.toLowerCase();
  }

  function Blob(parts, options) {
    if (!(this instanceof Blob)) throw new TypeError("Constructor Blob requires 'new'");
    // Store the parts as a list of chunks instead of eagerly concatenating them
    // into one contiguous buffer. A Blob built from ten 100 MB parts costs ~0 extra
    // memory at construction; the bytes are only joined on demand by
    // arrayBuffer()/bytes()/text(), and stream() emits them chunk by chunk.
    var chunks = [],
      total = 0;
    if (parts !== undefined && parts !== null) {
      if (typeof parts !== 'object' || typeof parts[Symbol.iterator] !== 'function') {
        throw new TypeError('The "parts" argument must be an iterable object');
      }
      // endings: 'native' converts line endings in string parts to the platform
      // newline; 'transparent' (the default) leaves them as-is.
      var nativeEndings = !!(options && options.endings === 'native');
      var list = Array.from(parts);
      for (var i = 0; i < list.length; i++) {
        var cs = blobPartToChunks(list[i], nativeEndings);
        for (var j = 0; j < cs.length; j++) {
          if (cs[j].length === 0) continue; // empty parts contribute nothing
          chunks.push(cs[j]);
          total += cs[j].length;
        }
      }
    }
    Object.defineProperty(this, '_parts', { value: chunks });
    Object.defineProperty(this, '_size', { value: total });
    Object.defineProperty(this, '_type', { value: normalizeBlobType(options) });
  }
  Object.defineProperty(Blob.prototype, 'size', {
    get: function () {
      return this._size; // O(1); no materialization
    },
    configurable: true,
  });
  Object.defineProperty(Blob.prototype, 'type', {
    get: function () {
      return this._type;
    },
    configurable: true,
  });
  Blob.prototype.arrayBuffer = function () {
    // The merged Uint8Array owns a buffer sized exactly to _size, so its .buffer is
    // already the right ArrayBuffer to hand back (a private copy of the contents).
    return Promise.resolve(blobJoin(this._parts, this._size).buffer);
  };
  Blob.prototype.bytes = function () {
    return Promise.resolve(blobJoin(this._parts, this._size));
  };
  // stream() returns a WHATWG ReadableStream that emits the Blob's bytes. We emit
  // each stored part as its own chunk (a fresh copy, so a consumer mutating a read
  // chunk can't write back into the Blob's immutable bytes), then close — Node
  // streams an in-memory Blob the same chunked way and likewise never materializes
  // the whole thing. node:stream/web is required lazily because it loads after
  // node:buffer (see internal/loader.js), so it is not available at eval time.
  Blob.prototype.stream = function () {
    var parts = this._parts;
    var ReadableStream = require('node:stream/web').ReadableStream;
    return new ReadableStream({
      start: function (controller) {
        for (var i = 0; i < parts.length; i++) controller.enqueue(new Uint8Array(parts[i]));
        controller.close();
      },
    });
  };
  Blob.prototype.text = function () {
    return Promise.resolve(Buffer.from(blobJoin(this._parts, this._size)).toString('utf8'));
  };
  Blob.prototype.slice = function (start, end, contentType) {
    var len = this._size;
    var s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    var e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    if (e < s) e = s;
    // Collect only the chunks overlapping [s, e) and copy just that range — slicing
    // a huge blob never materializes the whole thing. Each pushed subarray is a
    // view; the Blob constructor copies it (ArrayBuffer.isView path) to the new blob.
    var out = [];
    var pos = 0;
    var parts = this._parts;
    for (var i = 0; i < parts.length && pos < e; i++) {
      var part = parts[i];
      var pEnd = pos + part.length;
      if (pEnd > s) {
        out.push(part.subarray(pos < s ? s - pos : 0, pEnd > e ? e - pos : part.length));
      }
      pos = pEnd;
    }
    return new Blob(out, contentType === undefined ? undefined : { type: contentType });
  };
  Blob.prototype.toString = function () {
    return '[object Blob]';
  };

  function File(parts, name, options) {
    if (!(this instanceof File)) throw new TypeError("Constructor File requires 'new'");
    if (arguments.length < 2)
      throw new TypeError(
        "Failed to construct 'File': 2 arguments required, but only " +
          arguments.length +
          ' present.',
      );
    Blob.call(this, parts, options);
    Object.defineProperty(this, '_name', { value: String(name) });
    var lm =
      options && options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    Object.defineProperty(this, '_lastModified', { value: lm });
  }
  File.prototype = Object.create(Blob.prototype);
  File.prototype.constructor = File;
  Object.defineProperty(File.prototype, 'name', {
    get: function () {
      return this._name;
    },
    configurable: true,
  });
  Object.defineProperty(File.prototype, 'lastModified', {
    get: function () {
      return this._lastModified;
    },
    configurable: true,
  });

  if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
    Object.defineProperty(Blob.prototype, Symbol.toStringTag, {
      value: 'Blob',
      configurable: true,
    });
    Object.defineProperty(File.prototype, Symbol.toStringTag, {
      value: 'File',
      configurable: true,
    });
  }

  // --- blob: URL registry (URL.createObjectURL / buffer.resolveObjectURL) ----
  //
  // Node keeps Blobs created with URL.createObjectURL() in a process-wide
  // registry keyed by a `blob:nodedata:<uuid>` URL; buffer.resolveObjectURL()
  // looks one up and URL.revokeObjectURL() drops it. The registry lives here
  // because node:buffer owns Blob and exports resolveObjectURL, so the two
  // object-URL statics are attached to globalThis.URL from here. internal/url.js
  // provides the WHATWG URL class itself and copies these statics across when it
  // installs the global; both modules guard defensively so load order is moot.
  var objectUrlRegistry = new Map();

  function objectUrlId() {
    var c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // Defensive fallback: a v4 UUID from whatever randomness is available.
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) & 0xff;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var s = '';
    for (var j = 0; j < 16; j++) {
      s += (bytes[j] + 0x100).toString(16).slice(1);
      if (j === 3 || j === 5 || j === 7 || j === 9) s += '-';
    }
    return s;
  }

  function createObjectURL(obj) {
    if (!(obj instanceof Blob)) {
      var typeErr = new TypeError('The "obj" argument must be an instance of Blob.');
      typeErr.code = 'ERR_INVALID_ARG_TYPE';
      throw typeErr;
    }
    var id = 'blob:nodedata:' + objectUrlId();
    objectUrlRegistry.set(id, obj);
    return id;
  }

  function revokeObjectURL(url) {
    if (url === undefined) {
      var missingErr = new TypeError('The "url" argument must be specified');
      missingErr.code = 'ERR_MISSING_ARGS';
      throw missingErr;
    }
    // Coerce like Node; an unregistered or malformed id is a silent no-op.
    objectUrlRegistry.delete(String(url));
  }

  function resolveObjectURL(id) {
    // Node coerces the argument with `${id}`, so a URL object or anything with a
    // toString() resolves the same as its string form; a non-registered or junk
    // id then misses the registry and returns undefined (never throws). The
    // template form matches Node's ToString exactly — including throwing a
    // TypeError on a Symbol, which String(id) would silently stringify instead.
    var blob = objectUrlRegistry.get(`${id}`);
    if (blob === undefined) return;
    // Node returns a fresh Blob over the same bytes rather than the registered
    // instance, and a registered File resolves back as a plain Blob.
    return new Blob([blob], { type: blob.type });
  }

  if (globalThis.URL === undefined) {
    globalThis.URL = { createObjectURL: createObjectURL, revokeObjectURL: revokeObjectURL };
  } else {
    if (typeof globalThis.URL.createObjectURL !== 'function')
      globalThis.URL.createObjectURL = createObjectURL;
    if (typeof globalThis.URL.revokeObjectURL !== 'function')
      globalThis.URL.revokeObjectURL = revokeObjectURL;
  }

  if (globalThis.Buffer === undefined) {
    globalThis.Buffer = Buffer;
  }
  if (globalThis.Blob === undefined) {
    globalThis.Blob = Blob;
  }
  if (globalThis.File === undefined) {
    globalThis.File = File;
  }

  var exported = {
    Buffer: Buffer,
    SlowBuffer: SlowBuffer,
    Blob: Blob,
    File: File,
    kMaxLength: K_MAX_LENGTH,
    kStringMaxLength: K_STRING_MAX_LENGTH,
    constants: { MAX_LENGTH: K_MAX_LENGTH, MAX_STRING_LENGTH: K_STRING_MAX_LENGTH },
    atob: atob,
    btoa: btoa,
    isAscii: isAscii,
    isUtf8: isUtf8,
    transcode: transcode,
    resolveObjectURL: resolveObjectURL,
  };
  Object.defineProperty(exported, 'INSPECT_MAX_BYTES', {
    get: function () {
      return inspectMaxBytes;
    },
    set: function (value) {
      inspectMaxBytes = value;
    },
  });
  module.exports = exported;
});
