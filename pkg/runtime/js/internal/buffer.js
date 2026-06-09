// node:buffer — Buffer implemented as a Uint8Array subclass. The hot codecs are
// backed by Odin (pkg/runtime/buffer.odin); API glue and Node compatibility
// behavior live here.
(function (require, module, exports, native) {
  'use strict';

  if (!native) throw new Error('node:buffer requires native codec bindings');

  var utf8Encode = native.utf8Encode; // (string) -> Uint8Array
  var utf8Decode = native.utf8Decode; // (Uint8Array) -> string
  var hexEncode = native.hexEncode; // (Uint8Array) -> string
  var hexDecode = native.hexDecode; // (string) -> Uint8Array
  var base64Encode = native.base64Encode; // (Uint8Array) -> string

  var K_MAX_LENGTH = 0x7fffffff;
  var K_STRING_MAX_LENGTH = 0x1fffffff;
  var inspectMaxBytes = 50;

  function normalizeEncoding(encoding) {
    encoding = (encoding || 'utf8').toLowerCase();
    if (encoding === 'utf-8') return 'utf8';
    if (encoding === 'ucs2' || encoding === 'ucs-2' || encoding === 'utf-16le') return 'utf16le';
    if (encoding === 'binary') return 'latin1';
    return encoding;
  }

  function isEncodingName(encoding) {
    switch (normalizeEncoding(encoding)) {
      case 'utf8':
      case 'utf16le':
      case 'latin1':
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
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/]/g, '');
    if (str.length % 4 === 1) str = str.slice(0, str.length - 1);
    while (str.length % 4 !== 0) str += '=';
    return str;
  }

  function toBase64Url(str) {
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function utf16leEncode(str) {
    var out = new Uint8Array(str.length * 2);
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      out[i * 2] = code & 0xff;
      out[i * 2 + 1] = code >>> 8;
    }
    return out;
  }

  function utf16leDecode(bytes) {
    var out = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    }
    return out;
  }

  function strToBytes(str, encoding) {
    encoding = normalizeEncoding(encoding);
    if (encoding === 'utf8') return utf8Encode(String(str));
    if (encoding === 'utf16le') return utf16leEncode(String(str));
    if (encoding === 'hex') return hexDecode(String(str));
    if (encoding === 'base64' || encoding === 'base64url') {
      var norm = normalizeBase64(str);
      return norm ? native.base64Decode(norm) : new Uint8Array(0);
    }
    if (encoding === 'ascii' || encoding === 'latin1') {
      str = String(str);
      var a = new Uint8Array(str.length);
      for (var i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
      return a;
    }
    throw new TypeError('Unknown encoding: ' + encoding);
  }

  function bytesToString(bytes, encoding) {
    encoding = normalizeEncoding(encoding);
    if (encoding === 'utf8') return utf8Decode(bytes);
    if (encoding === 'utf16le') return utf16leDecode(bytes);
    if (encoding === 'hex') return hexEncode(bytes);
    if (encoding === 'base64') return base64Encode(bytes);
    if (encoding === 'base64url') return toBase64Url(base64Encode(bytes));
    if (encoding === 'ascii' || encoding === 'latin1') {
      var s = '';
      for (var i = 0; i < bytes.length; i++)
        s += String.fromCharCode(encoding === 'ascii' ? bytes[i] & 0x7f : bytes[i]);
      return s;
    }
    throw new TypeError('Unknown encoding: ' + encoding);
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

  function checkBounds(buf, offset, byteLength) {
    offset = toInteger(offset, 0);
    if (offset < 0 || offset + byteLength > buf.length)
      throw new RangeError('Offset is outside the bounds of the Buffer');
    return offset;
  }

  function validateRange(value, max, name) {
    value = toInteger(value, 0);
    if (value < 0 || value > max) throw new RangeError(name + ' is out of range');
    return value;
  }

  function viewOf(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function compareBytes(a, b) {
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

  function readUInt(buf, offset, byteLength, littleEndian) {
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
    var value = readUInt(buf, offset, byteLength, littleEndian);
    var sign = Math.pow(2, byteLength * 8 - 1);
    var full = sign * 2;
    return value >= sign ? value - full : value;
  }

  function writeUInt(buf, value, offset, byteLength, littleEndian) {
    offset = checkBounds(buf, offset, byteLength);
    value = Math.floor(Number(value));
    for (var i = 0; i < byteLength; i++) {
      var index = littleEndian ? offset + i : offset + byteLength - 1 - i;
      buf[index] = value & 0xff;
      value = Math.floor(value / 0x100);
    }
    return offset + byteLength;
  }

  function writeInt(buf, value, offset, byteLength, littleEndian) {
    value = Math.floor(Number(value));
    if (value < 0) value += Math.pow(2, byteLength * 8);
    return writeUInt(buf, value, offset, byteLength, littleEndian);
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
    offset = checkBounds(buf, offset, 8);
    value = BigInt(value);
    for (var i = 0; i < 8; i++) {
      var index = littleEndian ? offset + i : offset + 7 - i;
      buf[index] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
    }
    return offset + 8;
  }

  function writeBigInt(buf, value, offset, littleEndian) {
    value = BigInt(value);
    if (value < 0) value += BigInt(1) << BigInt(64);
    return writeBigUInt(buf, value, offset, littleEndian);
  }

  class Buffer extends Uint8Array {
    toString(encoding, start, end) {
      start = clampIndex(start, this.length, 0);
      end = clampIndex(end, this.length, this.length);
      if (end <= start) return '';
      return bytesToString(this.subarray(start, end), encoding || 'utf8');
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      targetStart = clampIndex(targetStart, target.length, 0);
      sourceStart = clampIndex(sourceStart, this.length, 0);
      sourceEnd = clampIndex(sourceEnd, this.length, this.length);
      var len = Math.min(sourceEnd - sourceStart, target.length - targetStart);
      if (len <= 0) return 0;
      target.set(this.subarray(sourceStart, sourceStart + len), targetStart);
      return len;
    }

    write(string, offset, length, encoding) {
      if (typeof offset === 'string') {
        encoding = offset;
        offset = 0;
        length = this.length;
      } else if (typeof length === 'string') {
        encoding = length;
        length = undefined;
      }
      offset = clampIndex(offset, this.length, 0);
      var bytes = strToBytes(String(string), encoding || 'utf8');
      length =
        length === undefined
          ? bytes.length
          : Math.min(toInteger(length, bytes.length), bytes.length);
      length = Math.min(length, this.length - offset);
      for (var i = 0; i < length; i++) this[offset + i] = bytes[i];
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
      start = clampIndex(start, this.length, 0);
      end = clampIndex(end, this.length, this.length);
      if (end <= start) return this;
      var bytes;
      if (typeof value === 'number') {
        bytes = new Uint8Array([value & 0xff]);
      } else if (value instanceof Uint8Array) {
        bytes = value.length ? value : new Uint8Array([0]);
      } else {
        bytes = strToBytes(String(value), encoding || 'utf8');
        if (bytes.length === 0) bytes = new Uint8Array([0]);
      }
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
      if (this.length % 2 !== 0) throw new RangeError('Buffer size must be a multiple of 16-bits');
      for (var i = 0; i < this.length; i += 2) {
        var a = this[i];
        this[i] = this[i + 1];
        this[i + 1] = a;
      }
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) throw new RangeError('Buffer size must be a multiple of 32-bits');
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
      if (this.length % 8 !== 0) throw new RangeError('Buffer size must be a multiple of 64-bits');
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
  p.inspect = function () {
    return '<Buffer ' + this.toString('hex').replace(/(..)/g, '$1 ').trim() + '>';
  };
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
    offset = checkBounds(this, offset, 1);
    this[offset] = Number(value) & 0xff;
    return offset + 1;
  };
  p.writeInt8 = function (value, offset) {
    return this.writeUInt8(value, offset);
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
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, Number(value), true);
    return offset + 2;
  };
  p.writeUInt16BE = p.writeUint16BE = function (value, offset) {
    offset = checkBounds(this, offset, 2);
    viewOf(this).setUint16(offset, Number(value), false);
    return offset + 2;
  };
  p.writeUInt32LE = p.writeUint32LE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, Number(value), true);
    return offset + 4;
  };
  p.writeUInt32BE = p.writeUint32BE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setUint32(offset, Number(value), false);
    return offset + 4;
  };
  p.writeInt16LE = function (value, offset) {
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, Number(value), true);
    return offset + 2;
  };
  p.writeInt16BE = function (value, offset) {
    offset = checkBounds(this, offset, 2);
    viewOf(this).setInt16(offset, Number(value), false);
    return offset + 2;
  };
  p.writeInt32LE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, Number(value), true);
    return offset + 4;
  };
  p.writeInt32BE = function (value, offset) {
    offset = checkBounds(this, offset, 4);
    viewOf(this).setInt32(offset, Number(value), false);
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

  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string') {
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
    if (value && typeof value.valueOf === 'function' && value.valueOf() !== value) {
      return Buffer.from(value.valueOf(), encodingOrOffset, length);
    }
    throw new TypeError(
      'The first argument must be a string, Buffer, ArrayBuffer, Array, or Array-like Object.',
    );
  };

  Buffer.alloc = function (size, fill, encoding) {
    var b = new Buffer(size >>> 0);
    if (fill !== undefined && fill !== 0) b.fill(fill, 0, b.length, encoding);
    return b;
  };

  Buffer.allocUnsafe = function (size) {
    return new Buffer(size >>> 0);
  };

  Buffer.allocUnsafeSlow = function (size) {
    return Buffer.allocUnsafe(size);
  };

  Buffer.isBuffer = function (b) {
    return b instanceof Buffer;
  };

  Buffer.isEncoding = function (encoding) {
    return typeof encoding === 'string' && isEncodingName(encoding);
  };

  Buffer.byteLength = function (string, encoding) {
    if (typeof string !== 'string') return string.length;
    return strToBytes(string, encoding || 'utf8').length;
  };

  Buffer.compare = function (a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array))
      throw new TypeError('Arguments must be Buffers or Uint8Arrays');
    return compareBytes(a, b);
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

  Buffer.poolSize = 8192;

  function SlowBuffer(size) {
    return Buffer.allocUnsafe(size);
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
    return Buffer.from(bytesToString(bytes, 'utf8'), 'utf8').equals(Buffer.from(bytes));
  }

  function transcode(source, fromEnc, toEnc) {
    return Buffer.from(Buffer.from(source).toString(fromEnc), toEnc);
  }

  // --- Blob / File (Web platform classes also exported from node:buffer) ----

  function blobPartToBytes(part) {
    if (part instanceof Blob) return part._bytes;
    if (part instanceof ArrayBuffer) return new Uint8Array(part.slice(0));
    if (ArrayBuffer.isView(part)) {
      return new Uint8Array(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
    }
    return new Uint8Array(Buffer.from(String(part), 'utf8'));
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
    var chunks = [],
      total = 0;
    if (parts !== undefined && parts !== null) {
      if (typeof parts !== 'object' || typeof parts[Symbol.iterator] !== 'function') {
        throw new TypeError('The "parts" argument must be an iterable object');
      }
      var list = Array.from(parts);
      for (var i = 0; i < list.length; i++) {
        var bytes = blobPartToBytes(list[i]);
        chunks.push(bytes);
        total += bytes.length;
      }
    }
    var merged = new Uint8Array(total),
      off = 0;
    for (var j = 0; j < chunks.length; j++) {
      merged.set(chunks[j], off);
      off += chunks[j].length;
    }
    Object.defineProperty(this, '_bytes', { value: merged });
    Object.defineProperty(this, '_type', { value: normalizeBlobType(options) });
  }
  Object.defineProperty(Blob.prototype, 'size', {
    get: function () {
      return this._bytes.length;
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
    var b = this._bytes;
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  Blob.prototype.bytes = function () {
    return Promise.resolve(new Uint8Array(this._bytes));
  };
  Blob.prototype.text = function () {
    return Promise.resolve(Buffer.from(this._bytes).toString('utf8'));
  };
  Blob.prototype.slice = function (start, end, contentType) {
    var len = this._bytes.length;
    var s = start === undefined ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    var e = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    var sub = this._bytes.subarray(s, Math.max(e, s));
    return new Blob([sub], contentType === undefined ? undefined : { type: contentType });
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

  if (typeof globalThis.Buffer === 'undefined') {
    globalThis.Buffer = Buffer;
  }
  if (typeof globalThis.Blob === 'undefined') {
    globalThis.Blob = Blob;
  }
  if (typeof globalThis.File === 'undefined') {
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
