// TextEncoder / TextDecoder (WHATWG Encoding standard), installed as globals.
// Built on Buffer for utf-8 and utf-16le; windows-1252 (the WHATWG alias for
// latin1/ascii) uses an explicit high-byte table so it is exact, not approximate.
(function (require, module, _exports) {
  'use strict';

  // --- Pollution-safe intrinsics -------------------------------------------
  // TextDecoder decodes attacker-controlled bytes, and url.js routes every
  // percent-decode and host-decode through it (percentDecode /
  // percentDecodeHostStrict), so this module inherits url's threat model: it
  // must be correct while user code has poisoned a shared prototype or replaced
  // a global — hardening url.js alone left this hole open. Prototype methods route
  // through the pristine primordials table; free globals and statics are
  // captured HERE, at module-eval, which the loader runs before any user code.
  //
  // The sharpest vector was `String.fromCharCode.apply(null, units)` in
  // unitsToString: `apply` is read off Function.prototype at call time, so a
  // poisoned Function.prototype.apply replaced the text of every decoded
  // string — `new URL('http://über.example/')` silently became `http://a/`.
  // ReflectApply (a captured static) closes it.
  var P = require('primordials');
  var ArrayPrototypePush = P.ArrayPrototypePush;
  var ArrayPrototypeSlice = P.ArrayPrototypeSlice;
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeCodePointAt = P.StringPrototypeCodePointAt;
  var StringPrototypeTrim = P.StringPrototypeTrim;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ReflectApply = P.ReflectApply;
  var TypeErrorG = P.TypeError;
  var RangeErrorG = P.RangeError;
  var Uint8ArrayG = P.Uint8Array;
  // Free globals / statics, captured pristine at module-eval.
  var StringG = String;
  var StringFromCharCode = String.fromCharCode;
  var ArrayBufferG = ArrayBuffer;
  var ArrayBufferIsView = ArrayBuffer.isView;

  var bufferModule = require('buffer');
  var Buffer = bufferModule.Buffer;

  // Only labels Lava can service are listed; unknown labels throw like Node.
  // Null-prototype because the keys come from the caller: with Object.prototype
  // in the chain, `new TextDecoder('constructor')` resolved to Object and
  // `new TextDecoder('__proto__')` to Object.prototype instead of throwing
  // RangeError, and any `Object.prototype.<label>` a script sets became a
  // forged encoding. Node's table is a null-prototype Map lookup in C++.
  var LABELS = {
    __proto__: null,
    'utf-8': 'utf-8',
    utf8: 'utf-8',
    'unicode-1-1-utf-8': 'utf-8',
    unicode11utf8: 'utf-8',
    unicode20utf8: 'utf-8',
    'x-unicode20utf8': 'utf-8',
    'utf-16le': 'utf-16le',
    'utf-16': 'utf-16le',
    'ucs-2': 'utf-16le',
    unicode: 'utf-16le',
    unicodefeff: 'utf-16le',
    csunicode: 'utf-16le',
    'iso-10646-ucs-2': 'utf-16le',
    'windows-1252': 'windows-1252',
    latin1: 'windows-1252',
    'iso-8859-1': 'windows-1252',
    'iso8859-1': 'windows-1252',
    iso88591: 'windows-1252',
    cp1252: 'windows-1252',
    'x-cp1252': 'windows-1252',
    cp819: 'windows-1252',
    ibm819: 'windows-1252',
    l1: 'windows-1252',
    ascii: 'windows-1252',
    'us-ascii': 'windows-1252',
    'ansi_x3.4-1968': 'windows-1252',
  };

  // windows-1252 code points for bytes 0x80-0x9F (others equal the byte value).
  var WIN1252_HIGH = [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144,
    8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376,
  ];

  function normalizeLabel(label) {
    return LABELS[
      StringPrototypeToLowerCase(
        StringPrototypeTrim(StringG(label === undefined ? 'utf-8' : label)),
      )
    ];
  }

  function toBytes(input, who) {
    if (input === undefined) return new Uint8ArrayG(0);
    if (input instanceof Uint8ArrayG) return input;
    if (input instanceof ArrayBufferG) return new Uint8ArrayG(input);
    if (ArrayBufferIsView(input))
      return new Uint8ArrayG(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeErrorG('The "' + who + '" argument must be an instance of ArrayBuffer or a view');
  }

  function TextEncoder() {
    if (!(this instanceof TextEncoder))
      throw new TypeErrorG("Constructor TextEncoder requires 'new'");
  }
  ObjectDefineProperty(TextEncoder.prototype, 'encoding', {
    get: function () {
      return 'utf-8';
    },
    configurable: true,
  });

  TextEncoder.prototype.encode = function (input) {
    return new Uint8ArrayG(Buffer.from(input === undefined ? '' : StringG(input), 'utf8'));
  };

  function encodeCodePoint(cp, dest, offset) {
    if (cp <= 0x7f) {
      dest[offset] = cp;
      return 1;
    }
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
    if (!(dest instanceof Uint8ArrayG))
      throw new TypeErrorG('The "dest" argument must be an instance of Uint8Array');
    source = StringG(source);
    var read = 0,
      written = 0,
      capacity = dest.length;
    for (var i = 0; i < source.length; ) {
      var cp = StringPrototypeCodePointAt(source, i);
      var units = cp > 0xffff ? 2 : 1;
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
      var size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
      if (written + size > capacity) break;
      written += encodeCodePoint(cp, dest, written);
      read += units;
      i += units;
    }
    return { read: read, written: written };
  };

  // Per-instance decoder state. WHATWG TextDecoder is stateful so that {stream:
  // true} can carry an incomplete trailing sequence into the next decode() call:
  // `needed/cp/seen/lower/upper` are the UTF-8 decoder state, `pend` a single
  // held UTF-16LE low byte, `hs` a held UTF-16 high surrogate, `bomChecked` marks
  // that the leading BOM window has closed, and `doNotFlush` records whether the
  // previous call was streaming (a non-streaming call resets the decoder first).
  function newDecoderState() {
    return {
      doNotFlush: false,
      bomChecked: false,
      needed: 0,
      cp: 0,
      seen: 0,
      lower: 0x80,
      upper: 0xbf,
      pend: -1,
      hs: -1,
    };
  }
  function resetDecoderState(s) {
    s.bomChecked = false;
    s.needed = 0;
    s.cp = 0;
    s.seen = 0;
    s.lower = 0x80;
    s.upper = 0xbf;
    s.pend = -1;
    s.hs = -1;
  }

  function fatalErr(enc) {
    var e = new TypeErrorG('The encoded data was not valid for encoding ' + enc);
    e.code = 'ERR_ENCODING_INVALID_ENCODED_DATA';
    return e;
  }

  function pushCodePoint(units, cp) {
    if (cp <= 0xffff) {
      ArrayPrototypePush(units, cp);
      return;
    }
    cp -= 0x10000;
    ArrayPrototypePush(units, 0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
  }

  // fromCharCode applied to the whole array blows the call stack past ~64k args,
  // so build the result in fixed chunks.
  function unitsToString(units) {
    if (units.length <= 0x2000) return ReflectApply(StringFromCharCode, null, units);
    var out = '';
    for (var i = 0; i < units.length; i += 0x2000) {
      out += ReflectApply(StringFromCharCode, null, ArrayPrototypeSlice(units, i, i + 0x2000));
    }
    return out;
  }

  // WHATWG "UTF-8 decoder" state machine (the streaming form of the maximal-
  // subpart rule the native Buffer codec implements). An invalid continuation
  // re-processes the offending byte so an ill-formed run yields one U+FFFD, not
  // one per byte. In fatal mode any error throws; otherwise it emits U+FFFD. An
  // incomplete trailing sequence is held across calls and only flushed (to one
  // U+FFFD, or an error when fatal) on the final, non-streaming call.
  function decodeUtf8(s, bytes, isFinal, fatal, units) {
    for (var i = 0; i < bytes.length; ) {
      var b = bytes[i];
      if (s.needed === 0) {
        if (b <= 0x7f) {
          ArrayPrototypePush(units, b);
          i++;
        } else if (b >= 0xc2 && b <= 0xdf) {
          s.needed = 1;
          s.cp = b & 0x1f;
          i++;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) s.lower = 0xa0;
          if (b === 0xed) s.upper = 0x9f;
          s.needed = 2;
          s.cp = b & 0x0f;
          i++;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) s.lower = 0x90;
          if (b === 0xf4) s.upper = 0x8f;
          s.needed = 3;
          s.cp = b & 0x07;
          i++;
        } else {
          if (fatal) throw fatalErr('utf-8');
          ArrayPrototypePush(units, 0xfffd);
          i++;
        }
      } else if (b < s.lower || b > s.upper) {
        s.cp = 0;
        s.needed = 0;
        s.seen = 0;
        s.lower = 0x80;
        s.upper = 0xbf;
        if (fatal) throw fatalErr('utf-8');
        ArrayPrototypePush(units, 0xfffd); // re-process b: do not advance i
      } else {
        s.lower = 0x80;
        s.upper = 0xbf;
        s.cp = (s.cp << 6) | (b & 0x3f);
        s.seen++;
        i++;
        if (s.seen === s.needed) {
          pushCodePoint(units, s.cp);
          s.cp = 0;
          s.needed = 0;
          s.seen = 0;
        }
      }
    }
    if (isFinal && s.needed !== 0) {
      s.cp = 0;
      s.needed = 0;
      s.seen = 0;
      s.lower = 0x80;
      s.upper = 0xbf;
      if (fatal) throw fatalErr('utf-8');
      ArrayPrototypePush(units, 0xfffd);
    }
  }

  // Emit one UTF-16 code unit, pairing surrogates and replacing lone ones with
  // U+FFFD (or throwing when fatal) — WHATWG behavior that differs from
  // Buffer.toString('utf16le'), which passes lone surrogates through verbatim.
  function pushU16(s, units, u, fatal) {
    if (s.hs >= 0) {
      if (u >= 0xdc00 && u <= 0xdfff) {
        ArrayPrototypePush(units, s.hs, u);
        s.hs = -1;
        return;
      }
      s.hs = -1;
      if (fatal) throw fatalErr('utf-16le');
      ArrayPrototypePush(units, 0xfffd);
      pushU16(s, units, u, fatal); // re-process u as a fresh unit
    } else if (u >= 0xd800 && u <= 0xdbff) {
      s.hs = u; // hold the high surrogate for its low half (possibly next chunk)
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      if (fatal) throw fatalErr('utf-16le');
      ArrayPrototypePush(units, 0xfffd);
    } else {
      ArrayPrototypePush(units, u);
    }
  }

  function decodeUtf16le(s, bytes, isFinal, fatal, units) {
    var i = 0;
    if (s.pend >= 0 && bytes.length > 0) {
      pushU16(s, units, s.pend | (bytes[0] << 8), fatal);
      s.pend = -1;
      i = 1;
    }
    for (; i + 2 <= bytes.length; i += 2) {
      pushU16(s, units, bytes[i] | (bytes[i + 1] << 8), fatal);
    }
    if (i < bytes.length) {
      // one trailing byte in this chunk
      if (isFinal) {
        if (fatal) throw fatalErr('utf-16le');
        ArrayPrototypePush(units, 0xfffd);
      } else {
        s.pend = bytes[i];
      }
    }
    if (isFinal) {
      if (s.hs >= 0) {
        s.hs = -1;
        if (fatal) throw fatalErr('utf-16le');
        ArrayPrototypePush(units, 0xfffd);
      }
      if (s.pend >= 0) {
        s.pend = -1;
        if (fatal) throw fatalErr('utf-16le');
        ArrayPrototypePush(units, 0xfffd);
      }
    }
  }

  function decodeWin1252Units(bytes, units) {
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      ArrayPrototypePush(units, b >= 0x80 && b <= 0x9f ? WIN1252_HIGH[b - 0x80] : b);
    }
  }

  function TextDecoder(label, options) {
    if (!(this instanceof TextDecoder))
      throw new TypeErrorG("Constructor TextDecoder requires 'new'");
    var enc = normalizeLabel(label);
    if (enc === undefined)
      throw new RangeErrorG("The encoding label provided ('" + label + "') is invalid.");
    // Null-prototype default so an omitted `options` cannot inherit fatal /
    // ignoreBOM from a poisoned Object.prototype — Node defaults to its
    // null-prototype kEmptyObject here for the same reason. An options object
    // the caller passes is read as-is, which is also what Node does.
    options = options || { __proto__: null };
    ObjectDefineProperty(this, '_enc', { value: enc });
    ObjectDefineProperty(this, '_fatal', { value: !!options.fatal });
    ObjectDefineProperty(this, '_ignoreBOM', { value: !!options.ignoreBOM });
    ObjectDefineProperty(this, '_state', { value: newDecoderState() });
  }
  ObjectDefineProperty(TextDecoder.prototype, 'encoding', {
    get: function () {
      return this._enc;
    },
    configurable: true,
  });
  ObjectDefineProperty(TextDecoder.prototype, 'fatal', {
    get: function () {
      return this._fatal;
    },
    configurable: true,
  });
  ObjectDefineProperty(TextDecoder.prototype, 'ignoreBOM', {
    get: function () {
      return this._ignoreBOM;
    },
    configurable: true,
  });

  TextDecoder.prototype.decode = function (input, options) {
    var bytes = toBytes(input, 'input');
    var stream = !!(options && options.stream);
    var s = this._state;
    // Fast path: a fresh, non-streaming, non-fatal utf-8 decode IS Buffer's
    // native utf8 decoder (invalid sequences -> U+FFFD), ~60x the per-unit JS
    // loop below. The BOM is stripped at the byte level (same result as
    // stripping U+FEFF from the output). Streaming, fatal, and runs chained
    // onto leftover streaming state still take the stateful JS decoder.
    if (this._enc === 'utf-8' && !this._fatal && !stream && !s.doNotFlush) {
      var off = 0;
      if (
        !this._ignoreBOM &&
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf
      ) {
        off = 3;
      }
      return Buffer.from(bytes.buffer, bytes.byteOffset + off, bytes.byteLength - off).toString(
        'utf8',
      );
    }
    // WHATWG: a non-streaming decode starts a fresh run (reset decoder + BOM
    // window); a streaming decode chains from the previous call's leftover state.
    if (!s.doNotFlush) resetDecoderState(s);
    s.doNotFlush = stream;
    var isFinal = !stream;

    var units = [];
    if (this._enc === 'windows-1252') {
      decodeWin1252Units(bytes, units);
    } else if (this._enc === 'utf-8') {
      decodeUtf8(s, bytes, isFinal, this._fatal, units);
    } else {
      decodeUtf16le(s, bytes, isFinal, this._fatal, units);
    }
    var result = unitsToString(units);
    // Strip the BOM once, at the first output of the (possibly chunked) stream.
    if (!s.bomChecked && result.length > 0) {
      s.bomChecked = true;
      // `result` is a string here — StringPrototypeSlice, not the array slice
      // used for the code-unit chunks in unitsToString.
      if (!this._ignoreBOM && StringPrototypeCharCodeAt(result, 0) === 0xfeff)
        result = StringPrototypeSlice(result, 1);
    }
    return result;
  };

  if (globalThis.TextEncoder === undefined) globalThis.TextEncoder = TextEncoder;
  if (globalThis.TextDecoder === undefined) globalThis.TextDecoder = TextDecoder;

  module.exports = { TextEncoder: TextEncoder, TextDecoder: TextDecoder };
});
