// node:punycode — RFC 3492 Punycode + IDNA helpers (the same surface as Node's
// deprecated punycode module / the standalone punycode.js). Used by IDN handling.
// This is the canonical reference algorithm (Mathias Bynens' punycode.js, MIT),
// adapted to the internal-module factory form.
(function (require, module, exports) {
  'use strict';

  var maxInt = 2147483647; // 0x7FFFFFFF
  var base = 36;
  var tMin = 1;
  var tMax = 26;
  var skew = 38;
  var damp = 700;
  var initialBias = 72;
  var initialN = 128; // 0x80
  var delimiter = '-';

  var regexPunycode = /^xn--/;
  var regexNonASCII = /[^\0-\x7E]/; // unprintable ASCII chars + non-ASCII chars
  var regexSeparators = /[\x2E。．｡]/g; // RFC 3490 separators

  var baseMinusTMin = base - tMin;
  var floor = Math.floor;
  var stringFromCharCode = String.fromCharCode;

  // Node-exact error messages (the standalone punycode.js strings).
  var errors = {
    overflow: 'Overflow: input needs wider integers to process',
    'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
    'invalid-input': 'Invalid input',
  };

  function error(type) {
    throw new RangeError(errors[type]);
  }

  function map(array, fn) {
    var result = [];
    for (var i = 0; i < array.length; i++) result[i] = fn(array[i]);
    return result;
  }

  function mapDomain(domain, fn) {
    var parts = domain.split('@');
    var result = '';
    if (parts.length > 1) {
      result = parts[0] + '@';
      domain = parts[1];
    }
    domain = domain.replace(regexSeparators, '\x2E');
    var labels = domain.split('.');
    var encoded = map(labels, fn).join('.');
    return result + encoded;
  }

  function ucs2decode(string) {
    var output = [];
    var counter = 0;
    var length = string.length;
    while (counter < length) {
      var value = string.charCodeAt(counter++);
      if (value >= 0xd800 && value <= 0xdbff && counter < length) {
        var extra = string.charCodeAt(counter++);
        if ((extra & 0xfc00) === 0xdc00) {
          output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
        } else {
          output.push(value);
          counter--;
        }
      } else {
        output.push(value);
      }
    }
    return output;
  }

  function ucs2encode(array) {
    // String.fromCodePoint throws a RangeError on an out-of-range/invalid code point
    // (matching Node's punycode.ucs2.encode) instead of silently wrapping via
    // fromCharCode; it also emits the surrogate pair for astral code points.
    return map(array, function (value) {
      return String.fromCodePoint(value);
    }).join('');
  }

  function basicToDigit(codePoint) {
    // Bounded on BOTH ends so a non-alphanumeric byte (e.g. '$') maps to `base` —
    // an invalid digit the decoder rejects — rather than a spurious/negative digit.
    if (codePoint >= 0x30 && codePoint < 0x3a) return codePoint - 0x16; // '0'-'9' -> 26-35
    if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41; // 'A'-'Z' -> 0-25
    if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61; // 'a'-'z' -> 0-25
    return base;
  }

  function digitToBasic(digit, flag) {
    return digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag !== 0 ? 1 : 0) << 5);
  }

  function adapt(delta, numPoints, firstTime) {
    var k = 0;
    delta = firstTime ? floor(delta / damp) : delta >> 1;
    delta += floor(delta / numPoints);
    for (; delta > (baseMinusTMin * tMax) >> 1; k += base) {
      delta = floor(delta / baseMinusTMin);
    }
    return floor(k + ((baseMinusTMin + 1) * delta) / (delta + skew));
  }

  function decode(input) {
    var output = [];
    var inputLength = input.length;
    var i = 0;
    var n = initialN;
    var bias = initialBias;

    var basic = input.lastIndexOf(delimiter);
    if (basic < 0) basic = 0;

    for (var j = 0; j < basic; ++j) {
      if (input.charCodeAt(j) >= 0x80) error('not-basic');
      output.push(input.charCodeAt(j));
    }

    for (var index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
      var oldi = i;
      for (var w = 1, k = base; ; k += base) {
        if (index >= inputLength) error('invalid-input');
        var digit = basicToDigit(input.charCodeAt(index++));
        if (digit >= base || digit > floor((maxInt - i) / w)) error('overflow');
        i += digit * w;
        var t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        var baseMinusT = base - t;
        if (w > floor(maxInt / baseMinusT)) error('overflow');
        w *= baseMinusT;
      }
      var out = output.length + 1;
      bias = adapt(i - oldi, out, oldi === 0);
      if (floor(i / out) > maxInt - n) error('overflow');
      n += floor(i / out);
      i %= out;
      output.splice(i++, 0, n);
    }

    return ucs2encode(output);
  }

  function encode(input) {
    var output = [];
    input = ucs2decode(input);
    var inputLength = input.length;
    var n = initialN;
    var delta = 0;
    var bias = initialBias;
    var i, cp;

    for (i = 0; i < inputLength; ++i) {
      cp = input[i];
      if (cp < 0x80) output.push(stringFromCharCode(cp));
    }

    var basicLength = output.length;
    var handledCPCount = basicLength;
    if (basicLength) output.push(delimiter);

    while (handledCPCount < inputLength) {
      var m = maxInt;
      for (i = 0; i < inputLength; ++i) {
        cp = input[i];
        if (cp >= n && cp < m) m = cp;
      }
      var handledCPCountPlusOne = handledCPCount + 1;
      if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error('overflow');
      delta += (m - n) * handledCPCountPlusOne;
      n = m;

      for (i = 0; i < inputLength; ++i) {
        cp = input[i];
        if (cp < n && ++delta > maxInt) error('overflow');
        if (cp === n) {
          var q = delta;
          for (var k = base; ; k += base) {
            var t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
            if (q < t) break;
            var qMinusT = q - t;
            var baseMinusT = base - t;
            output.push(stringFromCharCode(digitToBasic(t + (qMinusT % baseMinusT), 0)));
            q = floor(qMinusT / baseMinusT);
          }
          output.push(stringFromCharCode(digitToBasic(q, 0)));
          bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
          delta = 0;
          ++handledCPCount;
        }
      }
      ++delta;
      ++n;
    }
    return output.join('');
  }

  function toUnicode(input) {
    return mapDomain(input, function (string) {
      return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
    });
  }

  function toASCII(input) {
    return mapDomain(input, function (string) {
      return regexNonASCII.test(string) ? 'xn--' + encode(string) : string;
    });
  }

  module.exports = {
    version: '2.3.1',
    ucs2: { decode: ucs2decode, encode: ucs2encode },
    decode: decode,
    encode: encode,
    toASCII: toASCII,
    toUnicode: toUnicode,
  };
});
