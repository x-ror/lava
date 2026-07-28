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
  //
  // The decoders do NOT route their accumulator through a push primordial at
  // all — see the note on pushCodePoint. Routing those per-code-unit loops
  // through the variadic ArrayPrototypePush measured 1.43x on the JS decode
  // path (callerN's arguments switch is ~7x a direct call).
  var P = require('primordials');
  var StringPrototypeSlice = P.StringPrototypeSlice;
  var StringPrototypeCharCodeAt = P.StringPrototypeCharCodeAt;
  var StringPrototypeCodePointAt = P.StringPrototypeCodePointAt;
  var StringPrototypeToLowerCase = P.StringPrototypeToLowerCase;
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectFreeze = P.ObjectFreeze;
  var ReflectApply = P.ReflectApply;
  var TypeErrorG = P.TypeError;
  var RangeErrorG = P.RangeError;
  var Uint8ArrayG = P.Uint8Array;
  var Uint16ArrayG = P.Uint16Array;
  var TypedArrayPrototypeSubarray = P.TypedArrayPrototypeSubarray;
  var ArrayBufferG = P.ArrayBuffer;
  var ArrayBufferIsView = P.ArrayBufferIsView;
  // Free globals / statics, captured pristine at module-eval.
  var StringG = String;
  var StringFromCharCode = String.fromCharCode;

  // Buffer carries the utf-8 fast path and all of TextEncoder.encode, so its
  // methods are hardening-relevant exactly like String.fromCharCode: read live
  // off the (user-reachable) Buffer global, a replaced `Buffer.from` or
  // `Buffer.prototype.toString` rewrote every encoded/decoded string. Captured
  // here; invoked through a fixed-arity `.call` closure, the same shape and the
  // same residual as the primordials wrappers.
  var bufferModule = require('buffer');
  var Buffer = bufferModule.Buffer;
  var BufferFrom = Buffer.from;
  var BufferProtoToString = Buffer.prototype.toString;
  function bufferToStringUtf8(buf) {
    return BufferProtoToString.call(buf, 'utf8');
  }

  // Shared, frozen, null-prototype default options — the object is only ever
  // read, so one instance serves every construction. Mirrors Node's kEmptyObject
  // (a single frozen null-prototype object, not a per-call literal): an omitted
  // `options` must not inherit fatal/ignoreBOM from a poisoned Object.prototype.
  var kEmptyObject = ObjectFreeze({ __proto__: null });

  // Only labels Lava can service are listed; unknown labels throw like Node.
  // Null-prototype because the keys come from the caller: with Object.prototype
  // in the chain, `new TextDecoder('constructor')` resolved to Object and
  // `new TextDecoder('__proto__')` to Object.prototype instead of throwing
  // RangeError, and any `Object.prototype.<label>` a script sets became a
  // forged encoding. Node reaches the same end with a SafeMap in
  // lib/internal/encoding.js — Map keys never consult a prototype chain — and a
  // null-prototype object literal is the cheap equivalent for a static table.
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
    // WHATWG windows-1252 labels Node accepts and Lava used to reject. Pure
    // table parity — no new codec.
    'iso-ir-100': 'windows-1252',
    'iso_8859-1': 'windows-1252',
    'iso_8859-1:1987': 'windows-1252',
    csisolatin1: 'windows-1252',
  };

  // windows-1252 code points for bytes 0x80-0x9F (others equal the byte value).
  var WIN1252_HIGH = [
    8364, 129, 8218, 402, 8222, 8230, 8224, 8225, 710, 8240, 352, 8249, 338, 141, 381, 143, 144,
    8216, 8217, 8220, 8221, 8226, 8211, 8212, 732, 8482, 353, 8250, 339, 157, 382, 376,
  ];

  // WHATWG "get an encoding" strips leading/trailing ASCII whitespace only —
  // TAB/LF/FF/CR/SPACE, notably NOT vertical tab. String.prototype.trim also
  // strips Unicode whitespace, so it used to accept labels Node rejects
  // (' utf-8', '　utf-8'); Node carries its own trimAsciiWhitespace for
  // exactly this reason. Takes an already-coerced string.
  function isAsciiWhitespace(c) {
    return c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
  }
  function normalizeLabel(text) {
    var i = 0,
      j = text.length;
    while (i < j && isAsciiWhitespace(StringPrototypeCharCodeAt(text, i))) i++;
    while (j > i && isAsciiWhitespace(StringPrototypeCharCodeAt(text, j - 1))) j--;
    return LABELS[
      StringPrototypeToLowerCase(
        i === 0 && j === text.length ? text : StringPrototypeSlice(text, i, j),
      )
    ];
  }

  // Node's ERR_INVALID_ARG_TYPE "Received …" tail. buffer.js carries the same
  // shape as a file-private helper, and there is no shared errors module to
  // host it — exporting it from buffer.js would leak into the surface of
  // require('buffer'), so this stays a deliberate second, minimal copy.
  function describeReceived(v) {
    if (v === null) return 'null';
    var t = typeof v;
    if (t === 'undefined') return 'undefined';
    if (t === 'string') {
      var s = v.length > 28 ? StringPrototypeSlice(v, 0, 25) + '...' : v;
      return "type string ('" + s + "')";
    }
    if (t === 'number' || t === 'boolean') return 'type ' + t + ' (' + v + ')';
    if (t === 'bigint') return 'type bigint (' + v + 'n)';
    if (t === 'symbol') return 'type symbol (' + v.toString() + ')';
    var ctor = v.constructor && v.constructor.name;
    return 'an instance of ' + (ctor || 'Object');
  }

  function errInvalidArgType(message) {
    var e = new TypeErrorG(message);
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
  }

  // Node's validateObject(value, 'options', kValidateObjectAllowObjects) as it is
  // called from TextDecoder — nullable, and arrays and functions allowed. Verified
  // against node 24 rather than read off the docs: `null`, `[1,2]` and `()=>{}`
  // are accepted; every scalar including `-0`, `NaN`, `''` and `false` throws.
  // It runs BEFORE the label is looked at (see the constructor), which is why it
  // exists as a function instead of being folded into the `options || kEmptyObject`
  // line — the order is observable when both arguments are bad.
  // Callers guard with `options !== undefined && options !== null` before calling,
  // so the overwhelmingly common `new TextDecoder('utf-8')` / `decode(bytes)` pays
  // two comparisons and no call. The same test is repeated here because this is a
  // validator and must be correct when called directly. Worth the duplication:
  // as a bare call this cost 1.087x on `new-textdecoder` (200k constructions,
  // paired median of 15 launches); guarded it is 1.035x.
  function validateOptions(options) {
    if (options === undefined || options === null) return;
    var t = typeof options;
    if (t === 'object' || t === 'function') return;
    throw errInvalidArgType(
      'The "options" argument must be of type object. Received ' + describeReceived(options),
    );
  }

  function toBytes(input) {
    if (input === undefined) return new Uint8ArrayG(0);
    if (input instanceof Uint8ArrayG) return input;
    if (input instanceof ArrayBufferG) return new Uint8ArrayG(input);
    if (ArrayBufferIsView(input))
      return new Uint8ArrayG(input.buffer, input.byteOffset, input.byteLength);
    // Node names this argument "list" and appends no "Received" tail here,
    // unlike its other ERR_INVALID_ARG_TYPE messages. SharedArrayBuffer is in
    // the text because Node's is; Lava does not implement it, so that arm is
    // unreachable and the wording is parity-only.
    throw errInvalidArgType(
      'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.',
    );
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
    return new Uint8ArrayG(BufferFrom(input === undefined ? '' : StringG(input), 'utf8'));
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
      throw errInvalidArgType(
        'The "dest" argument must be an instance of Uint8Array. Received ' + describeReceived(dest),
      );
    source = StringG(source);
    var read = 0,
      written = 0,
      capacity = dest.length;
    // Surrogate pairing is done by hand off charCodeAt rather than by
    // codePointAt: the ASCII/BMP case (the overwhelming majority of input) then
    // costs a single primordial call and no branch on a >0xffff result, and the
    // astral case pays a second call it would otherwise pay inside codePointAt.
    for (var i = 0; i < source.length; ) {
      var cp = StringPrototypeCharCodeAt(source, i);
      var units = 1;
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < source.length) {
        var lo = StringPrototypeCharCodeAt(source, i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = (cp - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
          units = 2;
        }
      }
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

  // The code-unit accumulator is a PREALLOCATED, NULL-PROTOTYPE array written by
  // index, not a growing array written by push. Two reasons, both load-bearing:
  //   * a plain array inherits Array.prototype, and `Set(units, "0", v)` walks
  //     that chain — an accessor installed at Array.prototype[0] intercepted
  //     every stored code unit and fed the getter's value back to the string
  //     builder, which is a strictly weaker primitive than replacing push. This
  //     is the per-hot-array null prototype primordials.js assigns to the
  //     consuming module. It also drops Array.prototype.constructor out of
  //     reach, so the chunk slice can no longer be steered by Symbol.species.
  //   * it is faster than push through any wrapper: the accumulator writes are
  //     the per-code-unit inner loop of every non-fast-path decode.
  // Each emitter takes the write index and returns the next one.
  function pushCodePoint(units, n, cp) {
    if (cp <= 0xffff) {
      units[n] = cp;
      return n + 1;
    }
    cp -= 0x10000;
    units[n] = 0xd800 + (cp >> 10);
    units[n + 1] = 0xdc00 + (cp & 0x3ff);
    return n + 2;
  }

  // A Uint16Array's backing bytes ARE UTF-16 code units in platform order, so on
  // a little-endian target the decoded string is exactly what Buffer's native
  // utf16le codec produces from those same bytes — no per-unit JS work, no
  // chunking, no `apply` at all.
  //
  // This is not just tidier, it is why the accumulator could become a typed array
  // in the first place. String.fromCharCode.apply has a JSArray-only fast path in
  // JSC: over a Uint16Array subarray it costs 95.75ms where the plain Array cost
  // 44.18ms (3960 units x 3000 reps), which turned the memory fix into a 1.6-1.7x
  // decode regression. Routing the same bytes through the native codec measures
  // 13.74ms — 3.2x FASTER than the Array path this replaces. Numbers from
  // bench/micro/encoding.js's payload size; see the PR for the paired medians.
  var LITTLE_ENDIAN = (function () {
    var probe = new Uint16ArrayG(1);
    probe[0] = 0x0102;
    return new Uint8ArrayG(probe.buffer)[0] === 0x02;
  })();

  // fromCharCode applied to the whole array blows the call stack past ~64k args,
  // so the big-endian fallback builds the result in fixed chunks. `count` is the
  // number of units actually emitted; `units` is over-allocated, so every read
  // goes through subarray.
  function unitsToString(units, count) {
    if (count === 0) return '';
    if (LITTLE_ENDIAN)
      // The view is built with the PRIMORDIAL Uint8Array, not Buffer.from. This
      // module is hardened and buffer.js is not on this vector: Buffer.from routes
      // an ArrayBuffer argument through a live `ArrayBuffer.isView` read, so
      // poisoning globalThis.ArrayBuffer with a plain function made every decode
      // throw "ArrayBuffer.isView is not a function" — caught by
      // tests/node-compat/cases/55-encoding-pollution.js P2 the first time this
      // path shipped. Only the prototype METHOD is borrowed from Buffer, applied to
      // an ordinary Uint8Array, which is what buffer.js's toString already accepts.
      return BufferProtoToString.call(new Uint8ArrayG(units.buffer, 0, count * 2), 'utf16le');
    // Big-endian: Buffer's utf16le would byte-swap every unit. No target Lava
    // builds for is big-endian today, so this arm is correctness insurance for a
    // future port, not a live path — it is the exact code the fast arm replaced.
    var out = '';
    for (var i = 0; i < count; i += 0x2000) {
      out += ReflectApply(
        StringFromCharCode,
        null,
        TypedArrayPrototypeSubarray(units, i, i + 0x2000 < count ? i + 0x2000 : count),
      );
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
    var n = 0;
    for (var i = 0; i < bytes.length; ) {
      var b = bytes[i];
      if (s.needed === 0) {
        if (b <= 0x7f) {
          units[n++] = b;
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
          units[n++] = 0xfffd;
          i++;
        }
      } else if (b < s.lower || b > s.upper) {
        s.cp = 0;
        s.needed = 0;
        s.seen = 0;
        s.lower = 0x80;
        s.upper = 0xbf;
        if (fatal) throw fatalErr('utf-8');
        units[n++] = 0xfffd; // re-process b: do not advance i
      } else {
        s.lower = 0x80;
        s.upper = 0xbf;
        s.cp = (s.cp << 6) | (b & 0x3f);
        s.seen++;
        i++;
        if (s.seen === s.needed) {
          n = pushCodePoint(units, n, s.cp);
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
      units[n++] = 0xfffd;
    }
    return n;
  }

  // Emit one UTF-16 code unit, pairing surrogates and replacing lone ones with
  // U+FFFD (or throwing when fatal) — WHATWG behavior that differs from
  // Buffer.toString('utf16le'), which passes lone surrogates through verbatim.
  function pushU16(s, units, n, u, fatal) {
    if (s.hs >= 0) {
      if (u >= 0xdc00 && u <= 0xdfff) {
        units[n] = s.hs;
        units[n + 1] = u;
        s.hs = -1;
        return n + 2;
      }
      s.hs = -1;
      if (fatal) throw fatalErr('utf-16le');
      units[n++] = 0xfffd;
      return pushU16(s, units, n, u, fatal); // re-process u as a fresh unit
    } else if (u >= 0xd800 && u <= 0xdbff) {
      s.hs = u; // hold the high surrogate for its low half (possibly next chunk)
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      if (fatal) throw fatalErr('utf-16le');
      units[n++] = 0xfffd;
    } else {
      units[n++] = u;
    }
    return n;
  }

  function decodeUtf16le(s, bytes, isFinal, fatal, units) {
    var i = 0;
    var n = 0;
    if (s.pend >= 0 && bytes.length > 0) {
      n = pushU16(s, units, n, s.pend | (bytes[0] << 8), fatal);
      s.pend = -1;
      i = 1;
    }
    for (; i + 2 <= bytes.length; i += 2) {
      n = pushU16(s, units, n, bytes[i] | (bytes[i + 1] << 8), fatal);
    }
    if (i < bytes.length) {
      // one trailing byte in this chunk
      if (isFinal) {
        if (fatal) throw fatalErr('utf-16le');
        units[n++] = 0xfffd;
      } else {
        s.pend = bytes[i];
      }
    }
    if (isFinal) {
      if (s.hs >= 0) {
        s.hs = -1;
        if (fatal) throw fatalErr('utf-16le');
        units[n++] = 0xfffd;
      }
      if (s.pend >= 0) {
        s.pend = -1;
        if (fatal) throw fatalErr('utf-16le');
        units[n++] = 0xfffd;
      }
    }
    return n;
  }

  function decodeWin1252Units(bytes, units) {
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      units[i] = b >= 0x80 && b <= 0x9f ? WIN1252_HIGH[b - 0x80] : b;
    }
    return bytes.length;
  }

  function TextDecoder(label, options) {
    if (!(this instanceof TextDecoder))
      throw new TypeErrorG("Constructor TextDecoder requires 'new'");
    // Coerce ONCE: building the message from `label` again would run a
    // caller-supplied toString/Symbol.toPrimitive a second time, so the thrown
    // error could name a label that was never looked up. Node coerces once too.
    var text = label === undefined ? 'utf-8' : StringG(label);
    // Order is Node's, and it is observable in three places, so it is pinned by
    // 11-text-encoding.js rather than left to reading: the label is COERCED first
    // (a throwing toString wins over a bad options), options are VALIDATED second
    // (`new TextDecoder('bogus-enc', 5)` reports the options, not the encoding),
    // and only then is the label RESOLVED.
    if (options !== undefined && options !== null) validateOptions(options);
    var enc = normalizeLabel(text);
    if (enc === undefined) {
      var labelErr = new RangeErrorG('The "' + text + '" encoding is not supported');
      labelErr.code = 'ERR_ENCODING_NOT_SUPPORTED';
      throw labelErr;
    }
    // An omitted `options` must not inherit fatal/ignoreBOM from a poisoned
    // Object.prototype, hence the shared null-prototype kEmptyObject. An options
    // object the caller passes is read as-is, which is also what Node does once it
    // has validated the argument above.
    options = options || kEmptyObject;
    // `__proto__: null` on the descriptors: ToPropertyDescriptor reads get/set/
    // writable/enumerable with HasProperty, which walks the prototype chain, so
    // a poisoned `Object.prototype.get` (reachable from a JSON merge gadget,
    // {"__proto__":{"get":1}}) otherwise turns every one of these into a
    // TypeError and takes new URL() down with it. Node's internals do the same.
    ObjectDefineProperty(this, '_enc', { __proto__: null, value: enc });
    ObjectDefineProperty(this, '_fatal', { __proto__: null, value: !!options.fatal });
    ObjectDefineProperty(this, '_ignoreBOM', { __proto__: null, value: !!options.ignoreBOM });
    ObjectDefineProperty(this, '_state', { __proto__: null, value: newDecoderState() });
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
    // Before toBytes, matching Node: decode(5, 5) reports the options, not the
    // input. Same validator as the constructor.
    if (options !== undefined && options !== null) validateOptions(options);
    var bytes = toBytes(input);
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
      return bufferToStringUtf8(
        BufferFrom(bytes.buffer, bytes.byteOffset + off, bytes.byteLength - off),
      );
    }
    // WHATWG: a non-streaming decode starts a fresh run (reset decoder + BOM
    // window); a streaming decode chains from the previous call's leftover state.
    if (!s.doNotFlush) resetDecoderState(s);
    s.doNotFlush = stream;
    var isFinal = !stream;

    // Upper bound on emitted code units: utf-8 and windows-1252 emit at most one
    // per input byte (a 4-byte sequence yields a surrogate PAIR from 4 bytes),
    // utf-16le at most one per two, and a final flush adds at most two more.
    //
    // A Uint16Array, not a JS Array: every element here IS a UTF-16 code unit, so
    // two bytes each instead of a boxed 8-byte slot, and the storage is off the GC
    // heap. Measured on a 16 MB windows-1252 decode: 388 MB peak RSS -> 167 MB
    // against node 24's 135 MB, which is the difference between "scales with the
    // input" and "4x the input". url.js reaches this for any percent-encoded host
    // (percentDecodeHostStrict), so the input is attacker-sized. It also drops the
    // ObjectSetPrototypeOf hardening this line used to need: indexed access on a
    // typed array never consults the prototype chain, so there is nothing to
    // poison.
    var units = new Uint16ArrayG(bytes.length + 4);
    var count;
    if (this._enc === 'windows-1252') {
      count = decodeWin1252Units(bytes, units);
    } else if (this._enc === 'utf-8') {
      count = decodeUtf8(s, bytes, isFinal, this._fatal, units);
    } else {
      count = decodeUtf16le(s, bytes, isFinal, this._fatal, units);
    }
    var result = unitsToString(units, count);
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
