// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: Headers/Request/Response/Body machinery lives here, exactly as Node
// keeps it in JS; the actual `http://` network transport is Odin-backed and
// reached through the `native` bindings (native.request), mirroring how
// crypto/buffer receive their Odin primitives as the factory's fourth argument.
(function (require, module, exports, native) {
  'use strict';

  // Shared, lazily-created codecs. TextEncoder.encode / TextDecoder.decode
  // (non-streaming) are stateless across calls, so a single instance each is
  // reused across every body conversion instead of allocating one per call —
  // the previous per-call `new TextEncoder()/new TextDecoder()` sat on the hot
  // path (every Request/Response body, every .text()/.json()). They are created
  // on first use rather than at load time: loader.js may eager-require this
  // module before encoding.js installs the TextEncoder/TextDecoder globals, so
  // capturing them at load time would cache null and silently fall back to a
  // (wrong) latin1 round-trip (issue #43). getEncoder/getDecoder return null
  // only if the global never appears, in which case the latin1 fallbacks apply.
  var sharedEncoder = null;
  var sharedDecoder = null;
  function getEncoder() {
    if (sharedEncoder === null && typeof TextEncoder !== 'undefined')
      sharedEncoder = new TextEncoder();
    return sharedEncoder;
  }
  function getDecoder() {
    if (sharedDecoder === null && typeof TextDecoder !== 'undefined')
      sharedDecoder = new TextDecoder();
    return sharedDecoder;
  }

  function normalizeName(name) {
    return String(name).toLowerCase();
  }

  // Header names must be non-empty HTTP tokens (RFC 7230 tchar); values must not
  // carry CR, LF, or NUL. Node (undici) throws on either — at append/set/get/
  // has/delete time — so `new Headers(...)` and, because Request builds its
  // Headers eagerly, `fetch(input, {headers})` reject instead of silently
  // emitting a header-split or otherwise malformed request. The token class
  // rejects spaces, ':' (which would forge a second header on the wire), control
  // chars, and non-ASCII alike. Wire (response) headers arrive pre-framed via
  // _append and skip this, matching undici.
  var VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  function assertValidHeaderName(name) {
    if (!VALID_HEADER_NAME.test(name)) {
      throw new TypeError('Invalid header name: "' + name + '"');
    }
  }
  function assertValidHeaderValue(name, value) {
    if (/[\r\n\0]/.test(value)) {
      throw new TypeError('Invalid header value for "' + name + '": "' + value + '"');
    }
  }

  // Fetch spec "normalize a byte sequence" (https://fetch.spec.whatwg.org/#concept-header-value-normalize):
  // strip leading/trailing HTTP whitespace — tab (0x09), LF (0x0A), CR (0x0D),
  // space (0x20) — from a header value. undici applies this on the public
  // append/set path BEFORE validating, so a value like "\r\nfoo" normalizes to
  // "foo" and is accepted, while an interior CR/LF ("foo\r\nbar") survives the
  // trim and is then rejected by assertValidHeaderValue. Vertical tab / form
  // feed are not HTTP whitespace and are preserved. Wire (response) headers
  // arrive via _append and are not re-normalized — the transport already trims
  // OWS around values — matching undici, which fills response headers verbatim.
  function normalizeHeaderValue(value) {
    return value.replace(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
  }

  // Shared by Headers.append and Headers.set, which performed the identical
  // normalize→validate→coerce dance. Order matches undici: trim the value,
  // then reject a bad name, then reject a bad (trimmed) value. Returns the
  // cleaned name/value pair ready to store.
  function normalizeAndValidate(name, value) {
    var text = normalizeHeaderValue(String(value));
    var key = String(name);
    assertValidHeaderName(key);
    assertValidHeaderValue(key, text);
    return { name: key, value: text };
  }

  class Headers {
    constructor(init) {
      this._map = new Map();
      if (init instanceof Headers) {
        init.forEach((value, key) => this.append(key, value));
      } else if (Array.isArray(init)) {
        for (var i = 0; i < init.length; i++) this.append(init[i][0], init[i][1]);
      } else if (init && typeof init === 'object') {
        var keys = Object.keys(init);
        for (var j = 0; j < keys.length; j++) this.append(keys[j], init[keys[j]]);
      }
    }
    append(name, value) {
      var header = normalizeAndValidate(name, value);
      this._append(header.name, header.value);
    }
    // _append stores without validation — for response headers parsed off the
    // wire, which the transport has already framed line-by-line.
    _append(name, value) {
      var key = normalizeName(name);
      var existing = this._map.get(key);
      this._map.set(key, existing === undefined ? String(value) : existing + ', ' + value);
    }
    set(name, value) {
      var header = normalizeAndValidate(name, value);
      this._map.set(normalizeName(header.name), header.value);
    }
    get(name) {
      assertValidHeaderName(String(name));
      var v = this._map.get(normalizeName(name));
      return v === undefined ? null : v;
    }
    has(name) {
      assertValidHeaderName(String(name));
      return this._map.has(normalizeName(name));
    }
    delete(name) {
      assertValidHeaderName(String(name));
      this._map.delete(normalizeName(name));
    }
    forEach(callback, thisArg) {
      this._map.forEach((value, key) => callback.call(thisArg, value, key, this));
    }
    keys() {
      return this._map.keys();
    }
    values() {
      return this._map.values();
    }
    entries() {
      return this._map.entries();
    }
    [Symbol.iterator]() {
      return this._map.entries();
    }
  }

  // Body storage stays byte-exact; request bodies and response bytes must not
  // round-trip through latin1 text.
  function bodyToBytes(body) {
    if (body === null || body === undefined) return null;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    var text = typeof body === 'string' ? body : String(body);
    // An empty string (passed directly or produced by String(body)) has no
    // bytes — treat it as an absent body.
    if (text === '') return null;
    var encoder = getEncoder();
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  // bytesToText UTF-8 decodes stored bytes (matches Node's Body.text(); a latin1
  // fallback keeps things working if TextDecoder is somehow unavailable).
  function bytesToText(bytes) {
    if (bytes === null) return '';
    var decoder = getDecoder();
    if (decoder) return decoder.decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  class Body {
    constructor(body) {
      this._bodyBytes = bodyToBytes(body);
      this.bodyUsed = false;
    }
    text() {
      this.bodyUsed = true;
      return Promise.resolve(bytesToText(this._bodyBytes));
    }
    json() {
      this.bodyUsed = true;
      // Parse inside the promise chain so invalid JSON rejects rather than
      // throwing synchronously (WHATWG fetch semantics).
      return this.text().then(function (text) {
        return JSON.parse(text);
      });
    }
    arrayBuffer() {
      this.bodyUsed = true;
      var bytes = this._bodyBytes;
      if (bytes === null) return Promise.resolve(new ArrayBuffer(0));
      var copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return Promise.resolve(copy.buffer);
    }
  }

  class Response extends Body {
    constructor(body, init) {
      super(body);
      init = init || {};
      this.status = init.status === undefined ? 200 : init.status;
      this.statusText = init.statusText === undefined ? '' : init.statusText;
      this.headers = new Headers(init.headers);
      this.ok = this.status >= 200 && this.status < 300;
      this.redirected = false;
      this.type = 'default';
      this.url = init.url || '';
    }
    clone() {
      // NOTE: bodyToBytes returns a Uint8Array as-is, so the clone shares this
      // instance's underlying buffer. Safe while all reads are non-mutating
      // (text/json, and arrayBuffer which copies out); revisit if a mutating
      // body path is ever added.
      return new Response(this._bodyBytes, {
        status: this.status,
        statusText: this.statusText,
        headers: this.headers,
        url: this.url,
      });
    }
  }

  Response.json = function (data, init) {
    init = init || {};
    var headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), {
      status: init.status,
      statusText: init.statusText,
      headers: headers,
    });
  };

  Response.error = function () {
    return new Response(null, { status: 0 });
  };

  class Request extends Body {
    constructor(input, init) {
      init = init || {};
      // When input is another Request, its method/headers/body seed the new
      // one and init.* overrides them (WHATWG fetch). A string/URL input
      // contributes only the URL. We treat input as a Request when it carries
      // a string `url`, so URL objects (which stringify to their href) stay on
      // the string path.
      var src = input && typeof input === 'object' && typeof input.url === 'string' ? input : null;
      // Per spec, init.body overrides only when present and non-null; a null
      // or absent init.body keeps the source Request's body.
      var bodyInit =
        init.body !== undefined && init.body !== null
          ? init.body
          : src
            ? src._bodyBytes
            : init.body;
      super(bodyInit);
      this.url = src ? src.url : input == null ? '' : String(input);
      var method = init.method !== undefined ? init.method : src ? src.method : 'GET';
      this.method = String(method || 'GET').toUpperCase();
      // A GET/HEAD request cannot carry a body, whether that body came from
      // init or was inherited from a source Request (WHATWG fetch).
      if ((this.method === 'GET' || this.method === 'HEAD') && this._bodyBytes !== null) {
        throw new TypeError('Request with GET/HEAD method cannot have body.');
      }
      var headersInit = init.headers !== undefined ? init.headers : src ? src.headers : undefined;
      this.headers = new Headers(headersInit);
    }
  }

  // The transport sets these itself from the URL and body length; a caller copy
  // would otherwise be emitted as a duplicate header on the wire.
  var TRANSPORT_OWNED_HEADERS = {
    host: 1,
    'content-length': 1,
    connection: 1,
    'transfer-encoding': 1,
  };

  // fetch(input, init) — build a Request, then hand the method/url/headers/body
  // to the Odin transport. native.request settles by invoking one of the two
  // callbacks we pass: onResponse({status, statusText, headers, body}) on
  // success, or onError(message) on failure. The transport runs on the event
  // loop, so the returned promise resolves on a later tick. Only http:// is
  // wired today; https:// rejects from the native side.
  //
  // init.signal (AbortSignal) is honored: a pre-aborted signal rejects
  // immediately; an abort that fires mid-flight cancels the native transport
  // and rejects with the signal's reason.
  function fetch(input, init) {
    var req;
    try {
      req = new Request(input, init);
    } catch (error) {
      return Promise.reject(error);
    }

    if (!native || typeof native.request !== 'function') {
      return Promise.reject(new TypeError('fetch: native network backend unavailable'));
    }

    // Extract signal from init (not from the Request object, which doesn't
    // carry it — only the raw init dict does per the WHATWG fetch spec).
    var signal = init && init.signal != null ? init.signal : null;

    // Pre-aborted fast path: reject synchronously without touching the network.
    if (signal && signal.aborted) {
      return Promise.reject(signal.reason);
    }

    var headerLines = '';
    req.headers.forEach(function (value, key) {
      if (TRANSPORT_OWNED_HEADERS[key]) return;
      // Names/values were CR/LF/NUL-validated when set (see Headers.append),
      // so a header cannot split the request line here.
      headerLines += key + ': ' + String(value) + '\r\n';
    });
    var body = req._bodyBytes;

    return new Promise(function (resolve, reject) {
      var abortListener = null;

      function cleanup() {
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
      }

      function onResponse(raw) {
        cleanup();
        var headers = new Headers();
        var pairs = raw.headers || [];
        for (var i = 0; i + 1 < pairs.length; i += 2) headers._append(pairs[i], pairs[i + 1]);
        resolve(
          new Response(raw.body, {
            status: raw.status,
            statusText: raw.statusText,
            headers: headers,
            url: req.url,
          }),
        );
      }
      function onError(message) {
        cleanup();
        reject(new TypeError(String(message)));
      }

      var cancelFn = native.request(req.method, req.url, headerLines, body, onResponse, onError);

      if (signal) {
        abortListener = function () {
          cleanup();
          // Tear down the native transport without invoking onResponse/onError.
          if (typeof cancelFn === 'function') cancelFn();
          reject(signal.reason);
        };
        signal.addEventListener('abort', abortListener);
      }
    });
  }

  if (typeof globalThis.Headers === 'undefined') globalThis.Headers = Headers;
  if (typeof globalThis.Request === 'undefined') globalThis.Request = Request;
  if (typeof globalThis.Response === 'undefined') globalThis.Response = Response;
  if (typeof globalThis.fetch === 'undefined') globalThis.fetch = fetch;

  module.exports = { fetch: fetch, Headers: Headers, Request: Request, Response: Response };
});
