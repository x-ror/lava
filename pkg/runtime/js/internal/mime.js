// util.MIMEType / util.MIMEParams — a WHATWG MIME type parser, matching Node. Parsing
// lowercases the type, subtype and parameter names (values keep their case); serialization
// re-quotes a value only when it is empty or not an HTTP token. Internal state is held on
// Symbol-keyed slots (like URLSearchParams in url.js), not #private fields. Hidden from the
// public resolver; util.MIMEType / util.MIMEParams are the public surface.
(function (require, module) {
  'use strict';

  var kData = Symbol('data'); // MIMEParams: the Map of name -> value
  var kType = Symbol('type');
  var kSubtype = Symbol('subtype');
  var kParams = Symbol('params');

  // An HTTP token code point (RFC 9110): the chars allowed unquoted in a type/subtype/name.
  var NotHTTPTokenCodePoint = /[^!#$%&'*+\-.^_`|~A-Za-z0-9]/;
  // An HTTP quoted-string code point: tab, the printable ASCII range (U+0020..U+007E), and
  // the Latin-1 high range (U+0080..U+00FF). Anything else (other controls, newline) cannot
  // appear even inside quotes.
  var NotHTTPQuotedStringCodePoint = new RegExp(
    String.fromCharCode(91, 94, 9) +
      String.fromCharCode(32) +
      String.fromCharCode(45, 126) +
      String.fromCharCode(128) +
      String.fromCharCode(45, 255, 93),
  );
  var LEADING_HTTP_WS = /^[\t\n\f\r ]+/;
  var TRAILING_HTTP_WS = /[\t\n\f\r ]+$/;
  var ESCAPE_QUOTE_OR_BACKSLASH = /[\\"]/g;

  function isHTTPWhitespace(c) {
    return c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
  }

  function mimeError(production, input, index) {
    var msg = 'The MIME syntax for a ' + production + ' in "' + input + '" is invalid';
    if (index !== undefined && index !== -1) msg += ' at ' + index;
    var e = new TypeError(msg);
    e.code = 'ERR_INVALID_MIME_SYNTAX';
    return e;
  }

  // Validate a token production (type/subtype/parameter name). `input` is the string shown
  // in the error; `offset` shifts the reported index into that string.
  function validateToken(production, value, input, offset) {
    if (value.length === 0) throw mimeError(production, input, -1);
    var bad = value.search(NotHTTPTokenCodePoint);
    if (bad !== -1) throw mimeError(production, input, offset + bad);
  }

  function parse(str) {
    str = str.replace(LEADING_HTTP_WS, '').replace(TRAILING_HTTP_WS, '');
    var slash = str.indexOf('/');
    if (slash === -1) throw mimeError('type', str, -1);
    var type = str.slice(0, slash);
    validateToken('type', type, str, 0);

    var rest = str.slice(slash + 1);
    var semi = rest.indexOf(';');
    var subtype = (semi === -1 ? rest : rest.slice(0, semi)).replace(TRAILING_HTTP_WS, '');
    validateToken('subtype', subtype, str, slash + 1);

    var params = new Map();
    if (semi !== -1) parseParameters(rest.slice(semi + 1), params);
    return { type: type.toLowerCase(), subtype: subtype.toLowerCase(), params: params };
  }

  // WHATWG "parse a MIME type"'s parameters loop, over the text after the first ';'.
  function parseParameters(str, params) {
    var position = 0;
    var len = str.length;
    while (position < len) {
      while (position < len && isHTTPWhitespace(str[position])) position++;
      var nameStart = position;
      while (position < len && str[position] !== ';' && str[position] !== '=') position++;
      var name = str.slice(nameStart, position).toLowerCase();

      if (position < len && str[position] === ';') {
        position++;
        continue; // a bare name with no '=' is skipped
      }
      if (position >= len) break;
      position++; // skip '='

      var value;
      var quoted = false;
      if (position < len && str[position] === '"') {
        quoted = true;
        position++;
        var buf = '';
        while (position < len) {
          var ch = str[position];
          if (ch === '\\') {
            if (position + 1 < len) {
              buf += str[position + 1];
              position += 2;
              continue;
            }
            buf += '\\';
            position++;
            break;
          }
          if (ch === '"') {
            position++;
            break;
          }
          buf += ch;
          position++;
        }
        value = buf;
        while (position < len && str[position] !== ';') position++;
      } else {
        var valStart = position;
        while (position < len && str[position] !== ';') position++;
        value = str.slice(valStart, position).replace(TRAILING_HTTP_WS, '');
      }
      if (position < len) position++; // skip the ';'

      // Keep only well-formed, non-duplicate parameters (first wins). An empty value is
      // dropped only when it was unquoted; a quoted "" is a valid empty value, matching
      // Node/WHATWG (the empty-value skip applies to the unquoted collection only).
      if (
        name.length > 0 &&
        (quoted || value.length > 0) &&
        !NotHTTPTokenCodePoint.test(name) &&
        !NotHTTPQuotedStringCodePoint.test(value) &&
        !params.has(name)
      ) {
        params.set(name, value);
      }
    }
  }

  function encodeValue(value) {
    if (value.length === 0 || NotHTTPTokenCodePoint.test(value)) {
      return '"' + value.replace(ESCAPE_QUOTE_OR_BACKSLASH, '\\$&') + '"';
    }
    return value;
  }

  function MIMEParams() {
    this[kData] = new Map();
  }

  MIMEParams.prototype.get = function get(name) {
    var data = this[kData];
    name = `${name}`;
    return data.has(name) ? data.get(name) : null;
  };
  MIMEParams.prototype.has = function has(name) {
    return this[kData].has(`${name}`);
  };
  MIMEParams.prototype.set = function set(name, value) {
    var data = this[kData];
    name = `${name}`;
    value = `${value}`;
    if (name.length === 0) throw mimeError('parameter name', name, -1);
    var badName = name.search(NotHTTPTokenCodePoint);
    if (badName !== -1) throw mimeError('parameter name', name, badName);
    var badValue = value.search(NotHTTPQuotedStringCodePoint);
    if (badValue !== -1) throw mimeError('parameter value', value, badValue);
    data.set(name, value);
    return this;
  };
  MIMEParams.prototype.delete = function del(name) {
    this[kData].delete(`${name}`);
  };
  MIMEParams.prototype.entries = function entries() {
    return this[kData].entries();
  };
  MIMEParams.prototype.keys = function keys() {
    return this[kData].keys();
  };
  MIMEParams.prototype.values = function values() {
    return this[kData].values();
  };
  MIMEParams.prototype.toString = function toString() {
    var parts = [];
    this[kData].forEach(function (value, name) {
      parts.push(name + '=' + encodeValue(value));
    });
    return parts.join(';');
  };
  MIMEParams.prototype.toJSON = MIMEParams.prototype.toString;
  MIMEParams.prototype[Symbol.iterator] = MIMEParams.prototype.entries;

  function MIMEType(string) {
    var parsed = parse(`${string}`);
    this[kType] = parsed.type;
    this[kSubtype] = parsed.subtype;
    var params = new MIMEParams();
    params[kData] = parsed.params;
    this[kParams] = params;
  }

  Object.defineProperties(MIMEType.prototype, {
    type: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kType];
      },
      set: function (value) {
        value = `${value}`;
        validateToken('type', value, value, 0);
        this[kType] = value.toLowerCase();
      },
    },
    subtype: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kSubtype];
      },
      set: function (value) {
        value = `${value}`;
        validateToken('subtype', value, value, 0);
        this[kSubtype] = value.toLowerCase();
      },
    },
    essence: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kType] + '/' + this[kSubtype];
      },
    },
    params: {
      configurable: true,
      enumerable: true,
      get: function () {
        return this[kParams];
      },
    },
  });

  MIMEType.prototype.toString = function toString() {
    var paramStr = this[kParams].toString();
    return this[kType] + '/' + this[kSubtype] + (paramStr.length > 0 ? ';' + paramStr : '');
  };
  MIMEType.prototype.toJSON = MIMEType.prototype.toString;

  module.exports = { MIMEType: MIMEType, MIMEParams: MIMEParams };
});
