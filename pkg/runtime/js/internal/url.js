// node:url — WHATWG URL and URLSearchParams, implemented in JS (as Node does for
// the parsing-heavy modules like node:path) so the fiddly state-machine semantics
// match the URL Standard and Node byte-for-byte. JavaScriptCore's bare engine ships
// no URL/URLSearchParams (those are WebCore APIs), so the whole surface lives here.
//
// The module installs the `URL` and `URLSearchParams` globals (preserving the
// `createObjectURL`/`revokeObjectURL` statics that node:buffer attaches) and is
// exported by both `require('url')` and `require('node:url')`. It also keeps the
// `fileURLToPath` the ESM loader and node:sqlite depend on, and adds
// `pathToFileURL`, `urlToHttpOptions`, `format`, `domainToASCII`, `domainToUnicode`.
//
// Deliberate deviations from Node, documented in reference/node-compatibility.md:
//   * IDNA/UTS-46 host processing is approximated (NFC + lowercase + Punycode)
//     rather than the full ICU mapping; common Unicode domains round-trip, but
//     exotic mapping/validation edge cases may differ.
//   * The legacy `url.parse`/`url.resolve`/`url.Url` API is not provided; only the
//     WHATWG surface is.
(function (require, module, exports) {
  'use strict';

  // TextEncoder/TextDecoder are installed by internal/encoding.js. This module is
  // eagerly instantiated to install the URL/URLSearchParams globals, so the codecs
  // are created lazily (on first parse/serialize) rather than at module-eval time —
  // that keeps url.js robust to the loader's eager-instantiation order, since no
  // URL operation runs until user code, by which point every builtin has loaded.
  var encoderInstance = null;
  var decoderInstance = null;
  var fatalDecoderInstance = null;
  function encoder() {
    return encoderInstance || (encoderInstance = new TextEncoder());
  }
  function decoder() {
    return decoderInstance || (decoderInstance = new TextDecoder('utf-8'));
  }
  function fatalDecoder() {
    return (
      fatalDecoderInstance || (fatalDecoderInstance = new TextDecoder('utf-8', { fatal: true }))
    );
  }

  // A unique sentinel distinct from any valid parser result; using a symbol means
  // it can never collide with a legitimately-produced host string or number.
  var FAILURE = { failure: true };

  // ------------------------------------------------------------------ //
  // Percent-encoding                                                    //
  // ------------------------------------------------------------------ //

  function isHexDigit(c) {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
  }

  // The WHATWG percent-encode sets, each a predicate over a code point. Every set
  // is a superset of the C0-control set (control chars and everything past 0x7E).
  function inC0ControlSet(cp) {
    return cp <= 0x1f || cp > 0x7e;
  }
  function inFragmentSet(cp) {
    return (
      inC0ControlSet(cp) || cp === 0x20 || cp === 0x22 || cp === 0x3c || cp === 0x3e || cp === 0x60
    );
  }
  function inQuerySet(cp) {
    return (
      inC0ControlSet(cp) || cp === 0x20 || cp === 0x22 || cp === 0x23 || cp === 0x3c || cp === 0x3e
    );
  }
  function inSpecialQuerySet(cp) {
    return inQuerySet(cp) || cp === 0x27;
  }
  function inPathSet(cp) {
    return inQuerySet(cp) || cp === 0x3f || cp === 0x60 || cp === 0x7b || cp === 0x7d;
  }
  function inUserinfoSet(cp) {
    return (
      inPathSet(cp) ||
      cp === 0x2f ||
      cp === 0x3a ||
      cp === 0x3b ||
      cp === 0x3d ||
      cp === 0x40 ||
      cp === 0x5b ||
      cp === 0x5c ||
      cp === 0x5d ||
      cp === 0x5e ||
      cp === 0x7c
    );
  }

  function percentEncodeByte(b) {
    var hex = b.toString(16).toUpperCase();
    return '%' + (hex.length === 1 ? '0' + hex : hex);
  }

  // UTF-8 percent-encode a string: code points in `inSet` (or any non-ASCII, since
  // the sets all include >0x7E) are encoded to their UTF-8 bytes; the rest pass
  // through. Iterates by code point so astral characters encode as four bytes.
  function utf8PercentEncode(str, inSet) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var cp = str.codePointAt(i);
      if (cp > 0xffff) i++; // consumed a surrogate pair
      if (inSet(cp)) {
        var bytes = encoder().encode(String.fromCodePoint(cp));
        for (var b = 0; b < bytes.length; b++) out += percentEncodeByte(bytes[b]);
      } else {
        out += String.fromCodePoint(cp);
      }
    }
    return out;
  }

  // Percent-decode a string to its raw byte sequence. Non-%XX characters
  // contribute their own UTF-8 bytes so raw multibyte input survives.
  function percentDecodeBytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (
        c === 0x25 &&
        i + 2 < str.length &&
        isHexDigit(str.charCodeAt(i + 1)) &&
        isHexDigit(str.charCodeAt(i + 2))
      ) {
        bytes.push(parseInt(str.substr(i + 1, 2), 16));
        i += 2;
      } else {
        var cp = str.codePointAt(i);
        if (cp > 0xffff) i++;
        var enc = encoder().encode(String.fromCodePoint(cp));
        for (var k = 0; k < enc.length; k++) bytes.push(enc[k]);
      }
    }
    return new Uint8Array(bytes);
  }

  // Lenient percent-decode (invalid UTF-8 → U+FFFD), used for query/form parsing.
  function percentDecode(str) {
    return decoder().decode(percentDecodeBytes(str));
  }

  // Strict percent-decode for host parsing: invalid UTF-8 is a parse failure, as
  // the URL Standard's domain-to-ASCII step rejects it (Node throws to match).
  function percentDecodeHostStrict(str) {
    try {
      return fatalDecoder().decode(percentDecodeBytes(str));
    } catch (e) {
      return FAILURE;
    }
  }

  // ------------------------------------------------------------------ //
  // Punycode (RFC 3492) — used by the simplified IDNA host processing.  //
  // ------------------------------------------------------------------ //

  var PUNY_BASE = 36;
  var PUNY_TMIN = 1;
  var PUNY_TMAX = 26;
  var PUNY_SKEW = 38;
  var PUNY_DAMP = 700;
  var PUNY_INITIAL_BIAS = 72;
  var PUNY_INITIAL_N = 128;

  function punyAdapt(delta, numPoints, firstTime) {
    delta = firstTime ? Math.floor(delta / PUNY_DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    var k = 0;
    while (delta > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1) {
      delta = Math.floor(delta / (PUNY_BASE - PUNY_TMIN));
      k += PUNY_BASE;
    }
    return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * delta) / (delta + PUNY_SKEW));
  }

  function punyEncodeDigit(d) {
    // 0..25 -> a..z, 26..35 -> 0..9
    return d + 22 + (d < 26 ? 75 : 0);
  }
  function punyDecodeDigit(cp) {
    if (cp - 48 < 10) return cp - 22; // 0..9
    if (cp - 65 < 26) return cp - 65; // A..Z
    if (cp - 97 < 26) return cp - 97; // a..z
    return PUNY_BASE;
  }

  function punycodeEncode(input) {
    var output = [];
    var codePoints = [];
    for (var s = 0; s < input.length; s++) {
      var cp = input.codePointAt(s);
      if (cp > 0xffff) s++;
      codePoints.push(cp);
    }
    var n = PUNY_INITIAL_N;
    var delta = 0;
    var bias = PUNY_INITIAL_BIAS;
    var basicLength = 0;
    var i;
    for (i = 0; i < codePoints.length; i++) {
      if (codePoints[i] < 0x80) {
        output.push(codePoints[i]);
        basicLength++;
      }
    }
    var handled = basicLength;
    if (basicLength > 0) output.push(0x2d); // '-'
    while (handled < codePoints.length) {
      var m = 0x7fffffff;
      for (i = 0; i < codePoints.length; i++) {
        if (codePoints[i] >= n && codePoints[i] < m) m = codePoints[i];
      }
      delta += (m - n) * (handled + 1);
      n = m;
      for (i = 0; i < codePoints.length; i++) {
        var c = codePoints[i];
        if (c < n) delta++;
        if (c === n) {
          var q = delta;
          for (var k = PUNY_BASE; ; k += PUNY_BASE) {
            var t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
            if (q < t) break;
            output.push(punyEncodeDigit(t + ((q - t) % (PUNY_BASE - t))));
            q = Math.floor((q - t) / (PUNY_BASE - t));
          }
          output.push(punyEncodeDigit(q));
          bias = punyAdapt(delta, handled + 1, handled === basicLength);
          delta = 0;
          handled++;
        }
      }
      delta++;
      n++;
    }
    var str = '';
    for (i = 0; i < output.length; i++) str += String.fromCharCode(output[i]);
    return str;
  }

  function punycodeDecode(input) {
    var output = [];
    var n = PUNY_INITIAL_N;
    var bias = PUNY_INITIAL_BIAS;
    var i = 0;
    var basic = input.lastIndexOf('-');
    if (basic < 0) basic = 0;
    for (var j = 0; j < basic; j++) {
      if (input.charCodeAt(j) >= 0x80) throw new RangeError('Invalid input');
      output.push(input.charCodeAt(j));
    }
    var index = basic > 0 ? basic + 1 : 0;
    while (index < input.length) {
      var oldi = i;
      var w = 1;
      for (var k = PUNY_BASE; ; k += PUNY_BASE) {
        if (index >= input.length) throw new RangeError('Invalid input');
        var digit = punyDecodeDigit(input.charCodeAt(index++));
        if (digit >= PUNY_BASE) throw new RangeError('Invalid input');
        i += digit * w;
        var t = k <= bias ? PUNY_TMIN : k >= bias + PUNY_TMAX ? PUNY_TMAX : k - bias;
        if (digit < t) break;
        w *= PUNY_BASE - t;
      }
      var outLen = output.length + 1;
      bias = punyAdapt(i - oldi, outLen, oldi === 0);
      n += Math.floor(i / outLen);
      i %= outLen;
      output.splice(i, 0, n);
      i++;
    }
    var str = '';
    for (var o = 0; o < output.length; o++) str += String.fromCodePoint(output[o]);
    return str;
  }

  function hasNonASCII(str) {
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0x7f) return true;
    }
    return false;
  }

  // Simplified IDNA ToASCII. Approximates UTS-46 by: normalizing the three IDNA
  // label separators to '.', applying NFKC + lowercasing each Unicode label (so
  // fullwidth/compatibility characters fold the way ICU maps them), and emitting
  // the Punycode "xn--…" form. ASCII labels are just lowercased. Not the full ICU
  // mapping table, but round-trips the overwhelming majority of real domains.
  function domainToASCII(domain) {
    if (domain === '') return '';
    // IDEOGRAPHIC FULL STOP, FULLWIDTH FULL STOP, HALFWIDTH IDEOGRAPHIC FULL STOP.
    domain = domain.replace(/[。．｡]/g, '.');
    var labels = domain.split('.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (hasNonASCII(label)) {
        var mapped = (label.normalize ? label.normalize('NFKC') : label).toLowerCase();
        if (!hasNonASCII(mapped)) {
          // The mapping folded the label to pure ASCII (e.g. fullwidth digits).
          out.push(mapped);
          continue;
        }
        try {
          out.push('xn--' + punycodeEncode(mapped));
        } catch (e) {
          return FAILURE;
        }
      } else {
        out.push(label.toLowerCase());
      }
    }
    return out.join('.');
  }

  function domainToUnicode(domain) {
    if (domain === '') return '';
    var labels = domain.split('.');
    var out = [];
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (label.slice(0, 4).toLowerCase() === 'xn--') {
        try {
          out.push(punycodeDecode(label.slice(4)));
        } catch (e) {
          out.push(label);
        }
      } else {
        out.push(label);
      }
    }
    return out.join('.');
  }

  // ------------------------------------------------------------------ //
  // Host parsing                                                        //
  // ------------------------------------------------------------------ //

  // Forbidden host code points (opaque hosts) and the stricter forbidden domain
  // set (special-scheme hosts), per the URL Standard.
  function isForbiddenHostCodePoint(cp) {
    return (
      cp === 0x00 ||
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      cp === 0x20 ||
      cp === 0x23 ||
      cp === 0x2f ||
      cp === 0x3a ||
      cp === 0x3c ||
      cp === 0x3e ||
      cp === 0x3f ||
      cp === 0x40 ||
      cp === 0x5b ||
      cp === 0x5c ||
      cp === 0x5d ||
      cp === 0x5e ||
      cp === 0x7c
    );
  }
  function isForbiddenDomainCodePoint(cp) {
    return isForbiddenHostCodePoint(cp) || cp <= 0x1f || cp === 0x25 || cp === 0x7f;
  }

  function parseIPv4Number(input) {
    if (input === '') return FAILURE;
    var radix = 10;
    if (input.length >= 2 && input[0] === '0' && (input[1] === 'x' || input[1] === 'X')) {
      radix = 16;
      input = input.slice(2);
    } else if (input.length >= 2 && input[0] === '0') {
      radix = 8;
      input = input.slice(1);
    }
    if (input === '') return 0;
    var re = radix === 10 ? /^[0-9]+$/ : radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-7]+$/;
    if (!re.test(input)) return FAILURE;
    var n = parseInt(input, radix);
    if (!isFinite(n)) return FAILURE;
    return n;
  }

  function endsInANumber(input) {
    var parts = input.split('.');
    if (parts[parts.length - 1] === '') {
      if (parts.length === 1) return false;
      parts.pop();
    }
    var last = parts[parts.length - 1];
    if (last !== '' && /^[0-9]+$/.test(last)) return true;
    return parseIPv4Number(last) !== FAILURE;
  }

  function serializeIPv4(n) {
    var out = '';
    for (var i = 1; i <= 4; i++) {
      out = String(n % 256) + out;
      if (i !== 4) out = '.' + out;
      n = Math.floor(n / 256);
    }
    return out;
  }

  function parseIPv4(input) {
    var parts = input.split('.');
    if (parts[parts.length - 1] === '') {
      if (parts.length > 1) parts.pop();
    }
    if (parts.length > 4) return FAILURE;
    var numbers = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseIPv4Number(parts[i]);
      if (n === FAILURE) return FAILURE;
      numbers.push(n);
    }
    for (var j = 0; j < numbers.length; j++) {
      if (numbers[j] > 255 && j !== numbers.length - 1) return FAILURE;
    }
    if (numbers[numbers.length - 1] >= Math.pow(256, 5 - numbers.length)) return FAILURE;
    var ipv4 = numbers.pop();
    var counter = 0;
    for (var m = 0; m < numbers.length; m++) {
      ipv4 += numbers[m] * Math.pow(256, 3 - counter);
      counter++;
    }
    return serializeIPv4(ipv4);
  }

  function parseIPv6(input) {
    var address = [0, 0, 0, 0, 0, 0, 0, 0];
    var pieceIndex = 0;
    var compress = null;
    var cps = [];
    for (var s = 0; s < input.length; s++) cps.push(input.charCodeAt(s));
    var pointer = 0;
    function c() {
      return pointer < cps.length ? cps[pointer] : -1;
    }
    if (c() === 0x3a) {
      // ':'
      if (cps[pointer + 1] !== 0x3a) return FAILURE;
      pointer += 2;
      pieceIndex++;
      compress = pieceIndex;
    }
    while (c() !== -1) {
      if (pieceIndex === 8) return FAILURE;
      if (c() === 0x3a) {
        if (compress !== null) return FAILURE;
        pointer++;
        pieceIndex++;
        compress = pieceIndex;
        continue;
      }
      var value = 0;
      var length = 0;
      while (length < 4 && isHexDigit(c())) {
        value = value * 16 + parseInt(String.fromCharCode(c()), 16);
        pointer++;
        length++;
      }
      if (c() === 0x2e) {
        // '.', embedded IPv4
        if (length === 0) return FAILURE;
        pointer -= length;
        if (pieceIndex > 6) return FAILURE;
        var numbersSeen = 0;
        while (c() !== -1) {
          var ipv4Piece = null;
          if (numbersSeen > 0) {
            if (c() === 0x2e && numbersSeen < 4) pointer++;
            else return FAILURE;
          }
          if (c() < 0x30 || c() > 0x39) return FAILURE;
          while (c() >= 0x30 && c() <= 0x39) {
            var num = c() - 0x30;
            if (ipv4Piece === null) ipv4Piece = num;
            else if (ipv4Piece === 0) return FAILURE;
            else ipv4Piece = ipv4Piece * 10 + num;
            if (ipv4Piece > 255) return FAILURE;
            pointer++;
          }
          address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece;
          numbersSeen++;
          if (numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
        }
        if (numbersSeen !== 4) return FAILURE;
        break;
      } else if (c() === 0x3a) {
        pointer++;
        if (c() === -1) return FAILURE;
      } else if (c() !== -1) {
        return FAILURE;
      }
      address[pieceIndex] = value;
      pieceIndex++;
    }
    if (compress !== null) {
      var swaps = pieceIndex - compress;
      pieceIndex = 7;
      while (pieceIndex !== 0 && swaps > 0) {
        var tmp = address[compress + swaps - 1];
        address[compress + swaps - 1] = address[pieceIndex];
        address[pieceIndex] = tmp;
        pieceIndex--;
        swaps--;
      }
    } else if (compress === null && pieceIndex !== 8) {
      return FAILURE;
    }
    return '[' + serializeIPv6(address) + ']';
  }

  function serializeIPv6(address) {
    var output = '';
    // Find the longest run (length > 1) of zero pieces to compress.
    var longestIdx = -1;
    var longestLen = 0;
    var curIdx = -1;
    var curLen = 0;
    for (var i = 0; i < 8; i++) {
      if (address[i] === 0) {
        if (curIdx === -1) curIdx = i;
        curLen++;
        if (curLen > longestLen) {
          longestLen = curLen;
          longestIdx = curIdx;
        }
      } else {
        curIdx = -1;
        curLen = 0;
      }
    }
    var compress = longestLen > 1 ? longestIdx : -1;
    var ignore0 = false;
    for (var p = 0; p < 8; p++) {
      if (ignore0 && address[p] === 0) continue;
      else if (ignore0) ignore0 = false;
      if (compress === p) {
        output += p === 0 ? '::' : ':';
        ignore0 = true;
        continue;
      }
      output += address[p].toString(16);
      if (p !== 7) output += ':';
    }
    return output;
  }

  function parseOpaqueHost(input) {
    for (var i = 0; i < input.length; i++) {
      var cp = input.codePointAt(i);
      if (cp > 0xffff) i++;
      if (isForbiddenHostCodePoint(cp)) return FAILURE;
    }
    return utf8PercentEncode(input, inC0ControlSet);
  }

  function parseHost(input, isSpecial) {
    if (input[0] === '[') {
      if (input[input.length - 1] !== ']') return FAILURE;
      return parseIPv6(input.slice(1, -1));
    }
    if (!isSpecial) return parseOpaqueHost(input);
    var domain = percentDecodeHostStrict(input);
    if (domain === FAILURE) return FAILURE;
    var ascii = domainToASCII(domain);
    if (ascii === FAILURE) return FAILURE;
    for (var i = 0; i < ascii.length; i++) {
      if (isForbiddenDomainCodePoint(ascii.charCodeAt(i))) return FAILURE;
    }
    if (endsInANumber(ascii)) return parseIPv4(ascii);
    return ascii;
  }

  // ------------------------------------------------------------------ //
  // URL record + serialization                                         //
  // ------------------------------------------------------------------ //

  var SPECIAL_SCHEMES = {
    ftp: 21,
    file: null,
    http: 80,
    https: 443,
    ws: 80,
    wss: 443,
  };

  function isSpecialScheme(scheme) {
    return Object.prototype.hasOwnProperty.call(SPECIAL_SCHEMES, scheme);
  }

  function newRecord() {
    return {
      scheme: '',
      username: '',
      password: '',
      host: null,
      port: null,
      path: [], // array of segments, or a string when opaque
      query: null,
      fragment: null,
      opaque: false, // true => path is an opaque string
    };
  }

  function recordIsSpecial(url) {
    return isSpecialScheme(url.scheme);
  }

  function includesCredentials(url) {
    return url.username !== '' || url.password !== '';
  }

  function cannotHaveUsernamePasswordPort(url) {
    return url.host === null || url.host === '' || url.scheme === 'file';
  }

  function serializePath(url) {
    if (url.opaque) return url.path;
    if (url.path.length === 0) return '';
    return '/' + url.path.join('/');
  }

  function serializeHostPort(url) {
    if (url.host === null) return '';
    var out = url.host;
    if (url.port !== null) out += ':' + url.port;
    return out;
  }

  function serializeURL(url, excludeFragment) {
    var output = url.scheme + ':';
    if (url.host !== null) {
      output += '//';
      if (includesCredentials(url)) {
        output += url.username;
        if (url.password !== '') output += ':' + url.password;
        output += '@';
      }
      output += serializeHostPort(url);
    }
    if (url.host === null && !url.opaque && url.path.length > 1 && url.path[0] === '') {
      // Avoid the first empty segment being parsed back as an authority.
      output += '/.';
    }
    output += serializePath(url);
    if (url.query !== null) output += '?' + url.query;
    if (!excludeFragment && url.fragment !== null) output += '#' + url.fragment;
    return output;
  }

  function serializeOrigin(url) {
    switch (url.scheme) {
      case 'http':
      case 'https':
      case 'ws':
      case 'wss':
      case 'ftp':
        return url.scheme + '://' + serializeHostPort(url);
      case 'blob': {
        var pathStr = url.opaque ? url.path : serializePath(url);
        try {
          var inner = parseURLOrThrow(pathStr, undefined);
          return serializeOrigin(inner);
        } catch (e) {
          return 'null';
        }
      }
      default:
        return 'null';
    }
  }

  // ------------------------------------------------------------------ //
  // The basic URL parser (state machine, with state-override support)   //
  // ------------------------------------------------------------------ //

  var SCHEME_START = 0,
    SCHEME = 1,
    NO_SCHEME = 2,
    SPECIAL_RELATIVE_OR_AUTHORITY = 3,
    PATH_OR_AUTHORITY = 4,
    RELATIVE = 5,
    RELATIVE_SLASH = 6,
    SPECIAL_AUTHORITY_SLASHES = 7,
    SPECIAL_AUTHORITY_IGNORE_SLASHES = 8,
    AUTHORITY = 9,
    HOST = 10,
    PORT = 11,
    FILE = 12,
    FILE_SLASH = 13,
    FILE_HOST = 14,
    PATH_START = 15,
    PATH = 16,
    OPAQUE_PATH = 17,
    QUERY = 18,
    FRAGMENT = 19,
    // The hostname setter shares the HOST state machine but must stop before a
    // port (it returns at a top-level ':'). A distinct constant flags that.
    HOSTNAME = 20;

  function isASCIIAlpha(cp) {
    return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
  }
  function isASCIIDigit(cp) {
    return cp >= 0x30 && cp <= 0x39;
  }
  function isASCIIAlphanumeric(cp) {
    return isASCIIAlpha(cp) || isASCIIDigit(cp);
  }
  function isSingleDot(seg) {
    return seg === '.' || seg.toLowerCase() === '%2e';
  }
  function isDoubleDot(seg) {
    var l = seg.toLowerCase();
    return l === '..' || l === '.%2e' || l === '%2e.' || l === '%2e%2e';
  }
  function isWindowsDriveLetter(s) {
    return (
      s.length === 2 &&
      isASCIIAlpha(s.charCodeAt(0)) &&
      (s.charCodeAt(1) === 0x3a || s.charCodeAt(1) === 0x7c)
    );
  }
  function isNormalizedWindowsDriveLetter(s) {
    return s.length === 2 && isASCIIAlpha(s.charCodeAt(0)) && s.charCodeAt(1) === 0x3a;
  }
  function startsWithWindowsDriveLetter(str, i) {
    var rest = str.slice(i);
    return (
      rest.length >= 2 &&
      isWindowsDriveLetter(rest.slice(0, 2)) &&
      (rest.length === 2 ||
        rest[2] === '/' ||
        rest[2] === '\\' ||
        rest[2] === '?' ||
        rest[2] === '#')
    );
  }

  // Returns a url record on success, or FAILURE. `base` is a url record or
  // undefined; `url`/`stateOverride` drive the setter path.
  function basicURLParse(input, base, url, stateOverride) {
    if (url === undefined) {
      url = newRecord();
      // Remove leading/trailing C0 control or space (only when not a setter).
      input = input.replace(/^[\u0000-\u0020]+/, '').replace(/[\u0000-\u0020]+$/, '');
    }
    // Remove all ASCII tab or newline.
    input = input.replace(/[\t\n\r]/g, '');

    var cps = Array.from(input);
    var pointer = 0;
    // The hostname override runs the HOST state but is flagged via stateOverride
    // so the HOST case knows to stop before a port.
    var state =
      stateOverride === HOSTNAME
        ? HOST
        : stateOverride !== undefined
          ? stateOverride
          : SCHEME_START;
    var buffer = '';
    var atSignSeen = false;
    var insideBrackets = false;
    var passwordTokenSeen = false;
    var special = recordIsSpecial(url);

    function cp(idx) {
      return idx < cps.length ? cps[idx].codePointAt(0) : -1;
    }
    function remaining(n) {
      // The code point n positions past the current pointer (n === 0 is the
      // character immediately following the one being processed).
      return pointer + 1 + n < cps.length ? cps[pointer + 1 + n].codePointAt(0) : -1;
    }

    for (; pointer <= cps.length; pointer++) {
      var c = cp(pointer);
      switch (state) {
        case SCHEME_START:
          if (isASCIIAlpha(c)) {
            buffer += String.fromCharCode(c | 0x20);
            state = SCHEME;
          } else if (stateOverride === undefined) {
            state = NO_SCHEME;
            pointer--;
          } else {
            return FAILURE;
          }
          break;

        case SCHEME:
          if (isASCIIAlphanumeric(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
            buffer += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c | 0x20 : c);
          } else if (c === 0x3a) {
            if (stateOverride !== undefined) {
              var bufSpecial = isSpecialScheme(buffer);
              if (special && !bufSpecial) return url;
              if (!special && bufSpecial) return url;
              if ((includesCredentials(url) || url.port !== null) && buffer === 'file') return url;
              if (url.scheme === 'file' && url.host === '') return url;
            }
            url.scheme = buffer;
            if (stateOverride !== undefined) {
              if (url.port === SPECIAL_SCHEMES[url.scheme]) url.port = null;
              return url;
            }
            buffer = '';
            special = recordIsSpecial(url);
            if (url.scheme === 'file') {
              state = FILE;
            } else if (special && base !== undefined && base.scheme === url.scheme) {
              state = SPECIAL_RELATIVE_OR_AUTHORITY;
            } else if (special) {
              state = SPECIAL_AUTHORITY_SLASHES;
            } else if (remaining(0) === 0x2f) {
              state = PATH_OR_AUTHORITY;
              pointer++;
            } else {
              url.opaque = true;
              url.path = '';
              state = OPAQUE_PATH;
            }
          } else if (stateOverride === undefined) {
            buffer = '';
            state = NO_SCHEME;
            pointer = -1;
          } else {
            return FAILURE;
          }
          break;

        case NO_SCHEME:
          if (base === undefined || (base.opaque && c !== 0x23)) {
            return FAILURE;
          } else if (base.opaque && c === 0x23) {
            url.scheme = base.scheme;
            url.path = base.path;
            url.opaque = true;
            url.query = base.query;
            url.fragment = '';
            state = FRAGMENT;
          } else if (base.scheme !== 'file') {
            state = RELATIVE;
            pointer--;
          } else {
            state = FILE;
            pointer--;
          }
          break;

        case SPECIAL_RELATIVE_OR_AUTHORITY:
          if (c === 0x2f && remaining(0) === 0x2f) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer++;
          } else {
            state = RELATIVE;
            pointer--;
          }
          break;

        case PATH_OR_AUTHORITY:
          if (c === 0x2f) {
            state = AUTHORITY;
          } else {
            state = PATH;
            pointer--;
          }
          break;

        case RELATIVE:
          url.scheme = base.scheme;
          special = recordIsSpecial(url);
          if (c === 0x2f) {
            state = RELATIVE_SLASH;
          } else if (special && c === 0x5c) {
            state = RELATIVE_SLASH;
          } else {
            url.username = base.username;
            url.password = base.password;
            url.host = base.host;
            url.port = base.port;
            url.path = base.path.slice();
            url.query = base.query;
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            } else if (c !== -1) {
              url.query = null;
              url.path.pop();
              state = PATH;
              pointer--;
            }
          }
          break;

        case RELATIVE_SLASH:
          if (special && (c === 0x2f || c === 0x5c)) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
          } else if (c === 0x2f) {
            state = AUTHORITY;
          } else {
            url.username = base.username;
            url.password = base.password;
            url.host = base.host;
            url.port = base.port;
            state = PATH;
            pointer--;
          }
          break;

        case SPECIAL_AUTHORITY_SLASHES:
          if (c === 0x2f && remaining(0) === 0x2f) {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer++;
          } else {
            state = SPECIAL_AUTHORITY_IGNORE_SLASHES;
            pointer--;
          }
          break;

        case SPECIAL_AUTHORITY_IGNORE_SLASHES:
          if (c !== 0x2f && c !== 0x5c) {
            state = AUTHORITY;
            pointer--;
          }
          break;

        case AUTHORITY:
          if (c === 0x40) {
            if (atSignSeen) buffer = '%40' + buffer;
            atSignSeen = true;
            for (var bi = 0; bi < buffer.length; bi++) {
              var bcp = buffer.codePointAt(bi);
              if (bcp > 0xffff) bi++;
              if (bcp === 0x3a && !passwordTokenSeen) {
                passwordTokenSeen = true;
                continue;
              }
              var encoded = utf8PercentEncode(String.fromCodePoint(bcp), inUserinfoSet);
              if (passwordTokenSeen) url.password += encoded;
              else url.username += encoded;
            }
            buffer = '';
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c)
          ) {
            if (atSignSeen && buffer === '') return FAILURE;
            pointer -= Array.from(buffer).length + 1;
            buffer = '';
            state = HOST;
          } else {
            buffer += String.fromCodePoint(c);
          }
          break;

        case HOST:
          if (stateOverride !== undefined && url.scheme === 'file') {
            pointer--;
            state = FILE_HOST;
          } else if (c === 0x3a && !insideBrackets) {
            if (buffer === '') return FAILURE;
            // The hostname setter (HOSTNAME override) stops before a port.
            if (stateOverride === HOSTNAME) return url;
            var host = parseHost(buffer, special);
            if (host === FAILURE) return FAILURE;
            url.host = host;
            buffer = '';
            state = PORT;
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c)
          ) {
            pointer--;
            if (special && buffer === '') return FAILURE;
            if (
              stateOverride !== undefined &&
              buffer === '' &&
              (includesCredentials(url) || url.port !== null)
            )
              return url;
            var host2 = parseHost(buffer, special);
            if (host2 === FAILURE) return FAILURE;
            url.host = host2;
            buffer = '';
            state = PATH_START;
            if (stateOverride !== undefined) return url;
          } else {
            if (c === 0x5b) insideBrackets = true;
            else if (c === 0x5d) insideBrackets = false;
            buffer += String.fromCodePoint(c);
          }
          break;

        case PORT:
          if (isASCIIDigit(c)) {
            buffer += String.fromCharCode(c);
          } else if (
            c === -1 ||
            c === 0x2f ||
            c === 0x3f ||
            c === 0x23 ||
            (special && c === 0x5c) ||
            stateOverride !== undefined
          ) {
            if (buffer !== '') {
              var portNum = parseInt(buffer, 10);
              if (portNum > 65535) return FAILURE;
              url.port = portNum === SPECIAL_SCHEMES[url.scheme] ? null : portNum;
              buffer = '';
            }
            if (stateOverride !== undefined) return url;
            state = PATH_START;
            pointer--;
          } else {
            return FAILURE;
          }
          break;

        case FILE:
          url.scheme = 'file';
          special = true;
          url.host = '';
          if (c === 0x2f || c === 0x5c) {
            state = FILE_SLASH;
          } else if (base !== undefined && base.scheme === 'file') {
            url.host = base.host;
            url.path = base.path.slice();
            url.query = base.query;
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            } else if (c !== -1) {
              url.query = null;
              if (!startsWithWindowsDriveLetter(input, pointer)) {
                shortenPath(url);
              } else {
                url.path = [];
              }
              state = PATH;
              pointer--;
            }
          } else {
            state = PATH;
            pointer--;
          }
          break;

        case FILE_SLASH:
          if (c === 0x2f || c === 0x5c) {
            state = FILE_HOST;
          } else {
            if (
              base !== undefined &&
              base.scheme === 'file' &&
              !startsWithWindowsDriveLetter(input, pointer)
            ) {
              if (isNormalizedWindowsDriveLetter(base.path[0] || '')) {
                url.path.push(base.path[0]);
              } else {
                url.host = base.host;
              }
            }
            state = PATH;
            pointer--;
          }
          break;

        case FILE_HOST:
          if (c === -1 || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
            pointer--;
            if (stateOverride === undefined && isWindowsDriveLetter(buffer)) {
              state = PATH;
            } else if (buffer === '') {
              url.host = '';
              if (stateOverride !== undefined) return url;
              state = PATH_START;
            } else {
              var fhost = parseHost(buffer, special);
              if (fhost === FAILURE) return FAILURE;
              if (fhost === 'localhost') fhost = '';
              url.host = fhost;
              if (stateOverride !== undefined) return url;
              buffer = '';
              state = PATH_START;
            }
          } else {
            buffer += String.fromCodePoint(c);
          }
          break;

        case PATH_START:
          if (special) {
            state = PATH;
            if (c !== 0x2f && c !== 0x5c) pointer--;
          } else if (stateOverride === undefined && c === 0x3f) {
            url.query = '';
            state = QUERY;
          } else if (stateOverride === undefined && c === 0x23) {
            url.fragment = '';
            state = FRAGMENT;
          } else if (c !== -1) {
            state = PATH;
            if (c !== 0x2f) pointer--;
          } else if (stateOverride !== undefined && url.host === null) {
            url.path.push('');
          }
          break;

        case PATH:
          if (
            c === -1 ||
            c === 0x2f ||
            (special && c === 0x5c) ||
            (stateOverride === undefined && (c === 0x3f || c === 0x23))
          ) {
            if (isDoubleDot(buffer)) {
              shortenPath(url);
              if (c !== 0x2f && !(special && c === 0x5c)) url.path.push('');
            } else if (isSingleDot(buffer)) {
              if (c !== 0x2f && !(special && c === 0x5c)) url.path.push('');
            } else {
              if (url.scheme === 'file' && url.path.length === 0 && isWindowsDriveLetter(buffer)) {
                buffer = buffer[0] + ':';
              }
              url.path.push(buffer);
            }
            buffer = '';
            if (c === 0x3f) {
              url.query = '';
              state = QUERY;
            } else if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            }
          } else {
            buffer += utf8PercentEncode(String.fromCodePoint(c), inPathSet);
          }
          break;

        case OPAQUE_PATH:
          if (c === 0x3f) {
            url.query = '';
            state = QUERY;
          } else if (c === 0x23) {
            url.fragment = '';
            state = FRAGMENT;
          } else if (c !== -1) {
            url.path += utf8PercentEncode(String.fromCodePoint(c), inC0ControlSet);
          }
          break;

        case QUERY:
          if ((stateOverride === undefined && c === 0x23) || c === -1) {
            var querySet = special ? inSpecialQuerySet : inQuerySet;
            url.query += utf8PercentEncode(buffer, querySet);
            buffer = '';
            if (c === 0x23) {
              url.fragment = '';
              state = FRAGMENT;
            }
          } else if (c !== -1) {
            buffer += String.fromCodePoint(c);
          }
          break;

        case FRAGMENT:
          if (c !== -1) {
            url.fragment += utf8PercentEncode(String.fromCodePoint(c), inFragmentSet);
          }
          break;
      }
      if (pointer > cps.length) break;
    }
    return url;
  }

  function shortenPath(url) {
    if (url.opaque) return;
    var path = url.path;
    if (url.scheme === 'file' && path.length === 1 && isNormalizedWindowsDriveLetter(path[0])) {
      return;
    }
    path.pop();
  }

  function parseURLOrThrow(input, base) {
    var baseRecord;
    if (base !== undefined && base !== null) {
      baseRecord = basicURLParse(String(base), undefined);
      if (baseRecord === FAILURE) throw invalidURL(base);
    }
    var record = basicURLParse(String(input), baseRecord);
    if (record === FAILURE) throw invalidURL(input);
    return record;
  }

  function invalidURL(input) {
    var err = new TypeError('Invalid URL');
    err.code = 'ERR_INVALID_URL';
    err.input = String(input);
    return err;
  }

  // ------------------------------------------------------------------ //
  // application/x-www-form-urlencoded                                   //
  // ------------------------------------------------------------------ //

  function isFormUrlencodedSafe(cp) {
    return (
      cp === 0x2a ||
      cp === 0x2d ||
      cp === 0x2e ||
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      cp === 0x5f ||
      (cp >= 0x61 && cp <= 0x7a)
    );
  }

  function formUrlencodedByteSerialize(str) {
    var bytes = encoder().encode(str);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 0x20) out += '+';
      else if (isFormUrlencodedSafe(b)) out += String.fromCharCode(b);
      else out += percentEncodeByte(b);
    }
    return out;
  }

  function formUrlencodedParse(input) {
    var sequences = input === '' ? [] : input.split('&');
    var output = [];
    for (var i = 0; i < sequences.length; i++) {
      var bytes = sequences[i];
      if (bytes === '') continue;
      var name, value;
      var eq = bytes.indexOf('=');
      if (eq === -1) {
        name = bytes;
        value = '';
      } else {
        name = bytes.slice(0, eq);
        value = bytes.slice(eq + 1);
      }
      name = percentDecode(name.replace(/\+/g, ' '));
      value = percentDecode(value.replace(/\+/g, ' '));
      output.push([name, value]);
    }
    return output;
  }

  function formUrlencodedSerialize(list) {
    var out = '';
    for (var i = 0; i < list.length; i++) {
      if (i > 0) out += '&';
      out +=
        formUrlencodedByteSerialize(list[i][0]) + '=' + formUrlencodedByteSerialize(list[i][1]);
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // URLSearchParams                                                     //
  // ------------------------------------------------------------------ //

  var kList = Symbol('list');
  var kURLObject = Symbol('urlObject');

  function URLSearchParams(init) {
    this[kList] = [];
    this[kURLObject] = null;
    if (init === undefined || init === null) return;
    if (typeof init === 'object' || typeof init === 'function') {
      if (init instanceof URLSearchParams) {
        var src = init[kList];
        for (var i = 0; i < src.length; i++) this[kList].push([src[i][0], src[i][1]]);
        return;
      }
      if (typeof init[Symbol.iterator] === 'function') {
        var idx = 0;
        for (var pair of init) {
          if (typeof pair !== 'object' && typeof pair !== 'function') {
            throw new TypeError('The provided value cannot be converted to a sequence.');
          }
          var arr = [];
          for (var v of pair) arr.push(v);
          if (arr.length !== 2) {
            throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          }
          this[kList].push([toUSVString(arr[0]), toUSVString(arr[1])]);
          idx++;
        }
        return;
      }
      // Record of string -> string.
      var keys = Object.keys(init);
      for (var k = 0; k < keys.length; k++) {
        this[kList].push([toUSVString(keys[k]), toUSVString(init[keys[k]])]);
      }
      return;
    }
    // String init: strip a single leading '?'.
    var str = toUSVString(init);
    if (str[0] === '?') str = str.slice(1);
    this[kList] = formUrlencodedParse(str);
  }

  function toUSVString(value) {
    if (typeof value === 'string') return value;
    return String(value);
  }

  function spUpdate(sp) {
    var urlObj = sp[kURLObject];
    if (urlObj === null) return;
    var serialized = formUrlencodedSerialize(sp[kList]);
    urlObj._url.query = serialized === '' ? null : serialized;
  }

  Object.defineProperty(URLSearchParams.prototype, 'append', {
    configurable: true,
    writable: true,
    value: function append(name, value) {
      if (arguments.length < 2) {
        throw new TypeError('The "name" and "value" arguments must be specified');
      }
      this[kList].push([toUSVString(name), toUSVString(value)]);
      spUpdate(this);
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'delete', {
    configurable: true,
    writable: true,
    value: function del(name) {
      var n = toUSVString(name);
      var list = this[kList];
      if (arguments.length > 1 && arguments[1] !== undefined) {
        var val = toUSVString(arguments[1]);
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i][0] === n && list[i][1] === val) list.splice(i, 1);
        }
      } else {
        for (var j = list.length - 1; j >= 0; j--) {
          if (list[j][0] === n) list.splice(j, 1);
        }
      }
      spUpdate(this);
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'get', {
    configurable: true,
    writable: true,
    value: function get(name) {
      var n = toUSVString(name);
      var list = this[kList];
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === n) return list[i][1];
      }
      return null;
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'getAll', {
    configurable: true,
    writable: true,
    value: function getAll(name) {
      var n = toUSVString(name);
      var list = this[kList];
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i][0] === n) out.push(list[i][1]);
      }
      return out;
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'has', {
    configurable: true,
    writable: true,
    value: function has(name) {
      var n = toUSVString(name);
      var list = this[kList];
      if (arguments.length > 1 && arguments[1] !== undefined) {
        var val = toUSVString(arguments[1]);
        for (var i = 0; i < list.length; i++) {
          if (list[i][0] === n && list[i][1] === val) return true;
        }
        return false;
      }
      for (var j = 0; j < list.length; j++) {
        if (list[j][0] === n) return true;
      }
      return false;
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'set', {
    configurable: true,
    writable: true,
    value: function set(name, value) {
      if (arguments.length < 2) {
        throw new TypeError('The "name" and "value" arguments must be specified');
      }
      var n = toUSVString(name);
      var v = toUSVString(value);
      var list = this[kList];
      // Set the first matching tuple in place and drop the rest (URL Standard).
      var found = false;
      for (var i = 0; i < list.length; ) {
        if (list[i][0] === n) {
          if (found) {
            list.splice(i, 1);
            continue;
          }
          list[i][1] = v;
          found = true;
        }
        i++;
      }
      if (!found) list.push([n, v]);
      spUpdate(this);
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'sort', {
    configurable: true,
    writable: true,
    value: function sort() {
      // Stable sort by code units of the name only.
      this[kList].sort(function (a, b) {
        return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      });
      spUpdate(this);
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'forEach', {
    configurable: true,
    writable: true,
    value: function forEach(callback, thisArg) {
      if (typeof callback !== 'function') {
        throw new TypeError('Callback must be a function');
      }
      var list = this[kList];
      // Read length lazily so callbacks that append are observed (per spec).
      for (var i = 0; i < list.length; i++) {
        callback.call(thisArg, list[i][1], list[i][0], this);
      }
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'keys', {
    configurable: true,
    writable: true,
    value: function keys() {
      return makeSearchParamsIterator(this, 'key');
    },
  });
  Object.defineProperty(URLSearchParams.prototype, 'values', {
    configurable: true,
    writable: true,
    value: function values() {
      return makeSearchParamsIterator(this, 'value');
    },
  });
  Object.defineProperty(URLSearchParams.prototype, 'entries', {
    configurable: true,
    writable: true,
    value: function entries() {
      return makeSearchParamsIterator(this, 'key+value');
    },
  });
  Object.defineProperty(URLSearchParams.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: URLSearchParams.prototype.entries,
  });

  Object.defineProperty(URLSearchParams.prototype, 'size', {
    configurable: true,
    enumerable: true,
    get: function size() {
      return this[kList].length;
    },
  });

  Object.defineProperty(URLSearchParams.prototype, 'toString', {
    configurable: true,
    writable: true,
    value: function toString() {
      return formUrlencodedSerialize(this[kList]);
    },
  });

  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'URLSearchParams',
  });

  function makeSearchParamsIterator(sp, kind) {
    var index = 0;
    var iterator = {
      next: function next() {
        var list = sp[kList];
        if (index >= list.length) {
          return { value: undefined, done: true };
        }
        var entry = list[index];
        index++;
        var value;
        if (kind === 'key') value = entry[0];
        else if (kind === 'value') value = entry[1];
        else value = [entry[0], entry[1]];
        return { value: value, done: false };
      },
    };
    iterator[Symbol.iterator] = function () {
      return this;
    };
    Object.defineProperty(iterator, Symbol.toStringTag, {
      configurable: true,
      value: 'URLSearchParams Iterator',
    });
    return iterator;
  }

  // Build a URLSearchParams bound to a URL record (no constructor side effects).
  function newBoundSearchParams(urlObj) {
    var sp = Object.create(URLSearchParams.prototype);
    sp[kList] = urlObj._url.query === null ? [] : formUrlencodedParse(urlObj._url.query);
    sp[kURLObject] = urlObj;
    return sp;
  }

  // ------------------------------------------------------------------ //
  // URL                                                                 //
  // ------------------------------------------------------------------ //

  var kRecord = Symbol('record');
  var kSearchParams = Symbol('searchParams');

  function URL(input, base) {
    if (!(this instanceof URL)) {
      throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    }
    if (arguments.length === 0) {
      throw new TypeError("Failed to construct 'URL': 1 argument required, but only 0 present.");
    }
    this[kRecord] = parseURLOrThrow(input, base);
    this[kSearchParams] = null;
  }

  function refreshSearchParams(url) {
    if (url[kSearchParams] !== null) {
      var sp = url[kSearchParams];
      sp[kList] = url._url.query === null ? [] : formUrlencodedParse(url._url.query);
    }
  }

  Object.defineProperty(URL.prototype, '_url', {
    configurable: true,
    get: function () {
      return this[kRecord];
    },
  });

  Object.defineProperty(URL.prototype, 'href', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeURL(this[kRecord]);
    },
    set: function (value) {
      var record = basicURLParse(toUSVString(value), undefined);
      if (record === FAILURE) throw invalidURL(value);
      this[kRecord] = record;
      refreshSearchParams(this);
    },
  });

  Object.defineProperty(URL.prototype, 'origin', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeOrigin(this[kRecord]);
    },
  });

  Object.defineProperty(URL.prototype, 'protocol', {
    configurable: true,
    enumerable: true,
    get: function () {
      return this[kRecord].scheme + ':';
    },
    set: function (value) {
      basicURLParse(toUSVString(value) + ':', undefined, this[kRecord], SCHEME_START);
    },
  });

  Object.defineProperty(URL.prototype, 'username', {
    configurable: true,
    enumerable: true,
    get: function () {
      return this[kRecord].username;
    },
    set: function (value) {
      var url = this[kRecord];
      if (cannotHaveUsernamePasswordPort(url)) return;
      url.username = utf8PercentEncode(toUSVString(value), inUserinfoSet);
    },
  });

  Object.defineProperty(URL.prototype, 'password', {
    configurable: true,
    enumerable: true,
    get: function () {
      return this[kRecord].password;
    },
    set: function (value) {
      var url = this[kRecord];
      if (cannotHaveUsernamePasswordPort(url)) return;
      url.password = utf8PercentEncode(toUSVString(value), inUserinfoSet);
    },
  });

  Object.defineProperty(URL.prototype, 'host', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializeHostPort(this[kRecord]);
    },
    set: function (value) {
      var url = this[kRecord];
      if (url.opaque) return;
      basicURLParse(toUSVString(value), undefined, url, HOST);
    },
  });

  Object.defineProperty(URL.prototype, 'hostname', {
    configurable: true,
    enumerable: true,
    get: function () {
      return this[kRecord].host === null ? '' : this[kRecord].host;
    },
    set: function (value) {
      var url = this[kRecord];
      if (url.opaque) return;
      basicURLParse(toUSVString(value), undefined, url, HOSTNAME);
    },
  });

  Object.defineProperty(URL.prototype, 'port', {
    configurable: true,
    enumerable: true,
    get: function () {
      return this[kRecord].port === null ? '' : String(this[kRecord].port);
    },
    set: function (value) {
      var url = this[kRecord];
      if (cannotHaveUsernamePasswordPort(url)) return;
      var str = toUSVString(value);
      if (str === '') {
        url.port = null;
        return;
      }
      basicURLParse(str, undefined, url, PORT);
    },
  });

  Object.defineProperty(URL.prototype, 'pathname', {
    configurable: true,
    enumerable: true,
    get: function () {
      return serializePath(this[kRecord]);
    },
    set: function (value) {
      var url = this[kRecord];
      if (url.opaque) return;
      url.path = [];
      basicURLParse(toUSVString(value), undefined, url, PATH_START);
    },
  });

  Object.defineProperty(URL.prototype, 'search', {
    configurable: true,
    enumerable: true,
    get: function () {
      var q = this[kRecord].query;
      return q === null || q === '' ? '' : '?' + q;
    },
    set: function (value) {
      var url = this[kRecord];
      var str = toUSVString(value);
      if (str === '') {
        url.query = null;
        refreshSearchParams(this);
        return;
      }
      if (str[0] === '?') str = str.slice(1);
      url.query = '';
      basicURLParse(str, undefined, url, QUERY);
      refreshSearchParams(this);
    },
  });

  Object.defineProperty(URL.prototype, 'searchParams', {
    configurable: true,
    enumerable: true,
    get: function () {
      if (this[kSearchParams] === null) {
        this[kSearchParams] = newBoundSearchParams(this);
      }
      return this[kSearchParams];
    },
  });

  Object.defineProperty(URL.prototype, 'hash', {
    configurable: true,
    enumerable: true,
    get: function () {
      var f = this[kRecord].fragment;
      return f === null || f === '' ? '' : '#' + f;
    },
    set: function (value) {
      var url = this[kRecord];
      var str = toUSVString(value);
      if (str === '') {
        url.fragment = null;
        return;
      }
      if (str[0] === '#') str = str.slice(1);
      url.fragment = '';
      basicURLParse(str, undefined, url, FRAGMENT);
    },
  });

  Object.defineProperty(URL.prototype, 'toString', {
    configurable: true,
    writable: true,
    value: function toString() {
      return serializeURL(this[kRecord]);
    },
  });

  Object.defineProperty(URL.prototype, 'toJSON', {
    configurable: true,
    writable: true,
    value: function toJSON() {
      return serializeURL(this[kRecord]);
    },
  });

  Object.defineProperty(URL.prototype, Symbol.toStringTag, {
    configurable: true,
    value: 'URL',
  });

  // canParse / parse statics (Node 19+/22+).
  Object.defineProperty(URL, 'canParse', {
    configurable: true,
    writable: true,
    value: function canParse(input, base) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to execute 'canParse' on 'URL': 1 argument required.");
      }
      try {
        parseURLOrThrow(input, base);
        return true;
      } catch (e) {
        return false;
      }
    },
  });

  Object.defineProperty(URL, 'parse', {
    configurable: true,
    writable: true,
    value: function parse(input, base) {
      if (arguments.length === 0) {
        throw new TypeError("Failed to execute 'parse' on 'URL': 1 argument required.");
      }
      try {
        return new URL(input, base);
      } catch (e) {
        return null;
      }
    },
  });

  // ------------------------------------------------------------------ //
  // node:url helper functions                                          //
  // ------------------------------------------------------------------ //

  function fileURLToPath(input) {
    var href;
    if (typeof input === 'string') href = new URL(input).href;
    else if (input != null && typeof input === 'object' && typeof input.href === 'string')
      href = input.href;
    else href = new URL(String(input)).href;
    return fileURLToPathFromHref(href);
  }

  // The original file: → path translation (kept verbatim so the ESM loader and
  // node:sqlite, which call it on an href, behave exactly as before).
  function fileURLToPathFromHref(url) {
    if (url.slice(0, 5).toLowerCase() !== 'file:') {
      var schemeErr = new TypeError('The URL must be of scheme file');
      schemeErr.code = 'ERR_INVALID_URL_SCHEME';
      throw schemeErr;
    }
    var isWindows = process.platform === 'win32';
    var rest = url.slice(5);
    var host = '';
    if (rest.slice(0, 2) === '//') {
      rest = rest.slice(2);
      var slash = rest.indexOf('/');
      host = slash === -1 ? rest : rest.slice(0, slash);
      rest = slash === -1 ? '/' : rest.slice(slash);
    }
    var isLocalhost = host.toLowerCase() === 'localhost';
    var hash = rest.indexOf('#');
    if (hash !== -1) rest = rest.slice(0, hash);
    var query = rest.indexOf('?');
    if (query !== -1) rest = rest.slice(0, query);
    if (/%2f/i.test(rest) || (isWindows && /%5c/i.test(rest))) {
      var sepErr = new TypeError('File URL path must not include encoded / or \\ characters');
      sepErr.code = 'ERR_INVALID_FILE_URL_PATH';
      throw sepErr;
    }

    if (isWindows) {
      var winPath = decodeURIComponent(rest.replace(/\//g, '\\'));
      if (host !== '' && !isLocalhost) {
        return '\\\\' + host + winPath;
      }
      var letter = winPath.charCodeAt(1) | 0x20;
      if (letter < 97 || letter > 122 || winPath.charAt(2) !== ':') {
        var pathErr = new TypeError('File URL path must be absolute');
        pathErr.code = 'ERR_INVALID_FILE_URL_PATH';
        throw pathErr;
      }
      return winPath.slice(1);
    }

    if (host !== '' && !isLocalhost) {
      var hostErr = new TypeError(
        'File URL host must be "localhost" or empty on ' + process.platform,
      );
      hostErr.code = 'ERR_INVALID_FILE_URL_HOST';
      throw hostErr;
    }
    return decodeURIComponent(rest);
  }

  function pathToFileURL(filepath) {
    var path = require('node:path');
    var isWindows = process.platform === 'win32';
    var input = String(filepath);
    var resolved = path.resolve(input);
    // path.resolve drops a trailing separator; Node preserves it on the URL, so
    // re-append a '/' when the original path ended in one and resolve removed it.
    var lastChar = input.charCodeAt(input.length - 1);
    var endedWithSep = lastChar === 0x2f || (isWindows && lastChar === 0x5c);
    if (endedWithSep && resolved[resolved.length - 1] !== path.sep) resolved += '/';
    var url = new URL('file://');
    // Percent-encode the path's special characters, then assign as pathname so the
    // URL machinery normalizes it. We encode %, #, ? and (on POSIX) backslash so
    // they are not reinterpreted; control chars and others are handled by the setter.
    var encoded = resolved
      .replace(/%/g, '%25')
      .replace(/\\/g, isWindows ? '\\' : '%5C')
      .replace(/\n/g, '%0A')
      .replace(/\r/g, '%0D')
      .replace(/\t/g, '%09');
    if (isWindows) {
      // Normalize separators for the file URL; UNC paths keep the host.
      encoded = encoded.replace(/\\/g, '/');
      if (encoded.slice(0, 2) === '//') {
        // UNC \\server\share -> file://server/share
        var withoutLead = encoded.slice(2);
        var slash = withoutLead.indexOf('/');
        var serverHost = slash === -1 ? withoutLead : withoutLead.slice(0, slash);
        url.hostname = serverHost;
        url.pathname = slash === -1 ? '/' : withoutLead.slice(slash);
        return url;
      }
      url.pathname = '/' + encoded.replace(/^\/+/, '');
    } else {
      url.pathname = encoded;
    }
    return url;
  }

  function urlToHttpOptions(url) {
    var options = {
      protocol: url.protocol,
      hostname:
        typeof url.hostname === 'string' && url.hostname.startsWith('[')
          ? url.hostname.slice(1, -1)
          : url.hostname,
      hash: url.hash,
      search: url.search,
      pathname: url.pathname,
      path: '' + (url.pathname || '') + (url.search || ''),
      href: url.href,
    };
    if (url.port !== '') options.port = Number(url.port);
    if (url.username || url.password) {
      options.auth = decodeURIComponent(url.username) + ':' + decodeURIComponent(url.password);
    }
    return options;
  }

  function format(urlInput, options) {
    if (!(urlInput instanceof URL)) {
      throw new TypeError('The "url" argument must be an instance of URL.');
    }
    options = options || {};
    var auth = options.auth !== false;
    var fragment = options.fragment !== false;
    var search = options.search !== false;
    var unicode = options.unicode === true;

    var url = urlInput[kRecord];
    var output = url.scheme + ':';
    if (url.host !== null) {
      output += '//';
      var hasCreds = url.username !== '' || url.password !== '';
      if (auth && hasCreds) {
        output += url.username;
        if (url.password !== '') output += ':' + url.password;
        output += '@';
      }
      output += unicode ? domainToUnicode(url.host) : url.host;
      if (url.port !== null) output += ':' + url.port;
    }
    output += serializePath(url);
    if (search && url.query !== null) output += '?' + url.query;
    if (fragment && url.fragment !== null) output += '#' + url.fragment;
    return output;
  }

  // ------------------------------------------------------------------ //
  // Global installation + module exports                               //
  // ------------------------------------------------------------------ //

  // Preserve the object-URL statics node:buffer attaches to globalThis.URL (it may
  // have run first and stubbed URL, or may run after us). Copy any it already set
  // onto the real class so `URL.createObjectURL`/`revokeObjectURL` keep working.
  var priorURL = globalThis.URL;
  if (priorURL && typeof priorURL === 'object') {
    if (typeof priorURL.createObjectURL === 'function') {
      URL.createObjectURL = priorURL.createObjectURL;
    }
    if (typeof priorURL.revokeObjectURL === 'function') {
      URL.revokeObjectURL = priorURL.revokeObjectURL;
    }
  }

  if (typeof globalThis.URL !== 'function') {
    globalThis.URL = URL;
  }
  if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = URLSearchParams;
  }

  module.exports = {
    URL: URL,
    URLSearchParams: URLSearchParams,
    fileURLToPath: fileURLToPath,
    pathToFileURL: pathToFileURL,
    urlToHttpOptions: urlToHttpOptions,
    format: format,
    domainToASCII: function (domain) {
      var r = domainToASCII(String(domain === undefined ? 'undefined' : domain));
      return r === FAILURE ? '' : r;
    },
    domainToUnicode: function (domain) {
      return domainToUnicode(String(domain === undefined ? 'undefined' : domain));
    },
  };
});
