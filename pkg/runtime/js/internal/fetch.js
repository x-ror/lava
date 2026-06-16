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

  // concatChunks joins an array of Uint8Array chunks into one. Returns null for an
  // empty list (an absent body) and the single chunk as-is when there is only one.
  function concatChunks(chunks) {
    if (chunks.length === 0) return null;
    if (chunks.length === 1) return chunks[0];
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], off);
      off += chunks[j].length;
    }
    return out;
  }

  // chunkToBytes coerces a value yielded by a streaming request body (string,
  // ArrayBuffer, typed-array view, or Uint8Array) to bytes.
  function chunkToBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk))
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    var encoder = getEncoder();
    var text = typeof chunk === 'string' ? chunk : String(chunk);
    if (encoder) return encoder.encode(text);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  // BODY_HWM is the response-body high-water mark in bytes. When more than this
  // many undelivered bytes are queued in a BodyStream, its _desiredSize goes
  // non-positive and the native transport pauses the socket read until the
  // consumer drains below it (backpressure).
  var BODY_HWM = 64 * 1024;

  // BodyStream is a minimal, WHATWG-ReadableStream-shaped queue tailored to fetch
  // bodies. It is fed either by the native transport (push: _enqueue/_close/_error,
  // driven by the request's sink) or, for an in-memory body, by a single enqueued
  // chunk. It supports getReader().read(), async iteration, cancel(), tee(),
  // locked, and drives transport backpressure through its source.pull hook.
  class BodyStream {
    constructor(source) {
      this._source = source || {};
      this._queue = []; // Uint8Array chunks awaiting a reader
      this._queuedBytes = 0;
      this._state = 'readable'; // 'readable' | 'closed' | 'errored'
      this._storedError = undefined;
      this._reader = null; // active reader holds the lock
      this._disturbed = false; // a read or cancel has occurred (drives bodyUsed)
      this._pending = []; // [{resolve, reject}] reads waiting on a chunk
    }
    get locked() {
      return this._reader !== null;
    }
    // _desiredSize <= 0 tells the transport to pause; > 0 to keep reading.
    get _desiredSize() {
      if (this._state !== 'readable') return 0;
      return BODY_HWM - this._queuedBytes;
    }
    _enqueue(chunk) {
      if (this._state !== 'readable') return;
      if (this._pending.length > 0) {
        this._pending.shift().resolve({ value: chunk, done: false });
        return;
      }
      this._queue.push(chunk);
      this._queuedBytes += chunk.length;
    }
    _close() {
      if (this._state !== 'readable') return;
      this._state = 'closed';
      while (this._pending.length > 0) {
        this._pending.shift().resolve({ value: undefined, done: true });
      }
    }
    _error(err) {
      if (this._state !== 'readable') return;
      this._state = 'errored';
      this._storedError = err;
      this._queue = [];
      this._queuedBytes = 0;
      while (this._pending.length > 0) this._pending.shift().reject(err);
    }
    _readInternal() {
      this._disturbed = true;
      if (this._queue.length > 0) {
        var chunk = this._queue.shift();
        this._queuedBytes -= chunk.length;
        this._pull();
        return Promise.resolve({ value: chunk, done: false });
      }
      if (this._state === 'closed') return Promise.resolve({ value: undefined, done: true });
      if (this._state === 'errored') return Promise.reject(this._storedError);
      var self = this;
      var p = new Promise(function (resolve, reject) {
        self._pending.push({ resolve: resolve, reject: reject });
      });
      this._pull();
      return p;
    }
    // _pull asks the source for more once the buffer has room. The native source's
    // pull resumes a paused socket read; it is a cheap no-op when not paused, so it
    // is safe to call on every read.
    _pull() {
      if (this._state !== 'readable') return;
      if (this._queuedBytes >= BODY_HWM) return;
      var pull = this._source.pull;
      if (typeof pull === 'function') {
        try {
          pull();
        } catch (e) {}
      }
    }
    getReader(options) {
      if (options && options.mode !== undefined) throw new TypeError('Unsupported reader mode');
      if (this._reader) throw new TypeError('ReadableStream is already locked to a reader');
      var self = this;
      var released = false;
      var reader = {
        read: function () {
          if (released || self._reader !== reader)
            return Promise.reject(new TypeError('Reader has no associated stream'));
          return self._readInternal();
        },
        cancel: function (reason) {
          if (released) return Promise.resolve(undefined);
          return self.cancel(reason);
        },
        releaseLock: function () {
          if (released) return;
          released = true;
          if (self._reader === reader) self._reader = null;
        },
      };
      this._reader = reader;
      return reader;
    }
    cancel(reason) {
      this._disturbed = true;
      this._queue = [];
      this._queuedBytes = 0;
      if (this._state === 'readable') this._close();
      var cancel = this._source.cancel;
      if (typeof cancel === 'function') {
        try {
          cancel(reason);
        } catch (e) {}
      }
      return Promise.resolve(undefined);
    }
    tee() {
      if (this.locked) throw new TypeError('ReadableStream is already locked to a reader');
      var reader = this.getReader();
      var b1, b2;
      var reading = false;
      function pump() {
        if (reading) return;
        reading = true;
        reader.read().then(
          function (r) {
            reading = false;
            if (r.done) {
              b1._close();
              b2._close();
              return;
            }
            b1._enqueue(r.value);
            b2._enqueue(r.value);
            if (b1._desiredSize > 0 || b2._desiredSize > 0) pump();
          },
          function (e) {
            b1._error(e);
            b2._error(e);
          },
        );
      }
      var src = {
        pull: pump,
        cancel: function (reason) {
          reader.cancel(reason);
        },
      };
      b1 = new BodyStream(src);
      b2 = new BodyStream(src);
      return [b1, b2];
    }
    [Symbol.asyncIterator]() {
      var reader = this.getReader();
      return {
        next: function () {
          return reader.read();
        },
        return: function (value) {
          reader.cancel();
          reader.releaseLock();
          return Promise.resolve({ value: value, done: true });
        },
        [Symbol.asyncIterator]: function () {
          return this;
        },
      };
    }
  }

  // streamFromBytes wraps an in-memory body in a one-shot BodyStream so .body is a
  // ReadableStream (Node parity). Enqueuing does not mark the stream disturbed, so
  // merely reading `.body` does not flip bodyUsed.
  function streamFromBytes(bytes) {
    var s = new BodyStream({});
    if (bytes !== null && bytes !== undefined && bytes.length > 0) s._enqueue(bytes);
    s._close();
    return s;
  }

  // Body backs Request and Response. It holds EITHER an in-memory byte body
  // (_bodyBytes, the fast path for JS-constructed bodies and buffered request
  // bodies) OR a streaming body (_bodyStream, fed by the transport). The buffered
  // accessors (text/json/arrayBuffer/bytes) drain the stream when present, so
  // streaming and buffering share one consumption path and a body is consumed at
  // most once.
  class Body {
    constructor(bodyInit) {
      if (bodyInit instanceof BodyStream) {
        this._bodyStream = bodyInit;
        this._bodyBytes = undefined;
      } else {
        this._bodyStream = null;
        this._bodyBytes = bodyToBytes(bodyInit); // Uint8Array | null
      }
      this._bodyUsed = false;
    }
    get bodyUsed() {
      if (this._bodyUsed) return true;
      if (this._bodyStream) return this._bodyStream._disturbed;
      return false;
    }
    get body() {
      if (this._bodyStream) return this._bodyStream;
      if (this._bodyBytes === null || this._bodyBytes === undefined) return null;
      this._bodyStream = streamFromBytes(this._bodyBytes);
      return this._bodyStream;
    }
    async _consume() {
      if (this.bodyUsed) throw new TypeError('Body is unusable: Body has already been read');
      if (this._bodyStream && this._bodyStream.locked)
        throw new TypeError('Body is unusable: ReadableStream is locked');
      this._bodyUsed = true;
      if (this._bodyStream) {
        var reader = this._bodyStream.getReader();
        var chunks = [];
        try {
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
          }
        } finally {
          reader.releaseLock();
        }
        return concatChunks(chunks);
      }
      return this._bodyBytes; // Uint8Array | null
    }
    text() {
      return this._consume().then(function (bytes) {
        return bytesToText(bytes);
      });
    }
    json() {
      // Parse inside the chain so invalid JSON rejects (WHATWG fetch semantics).
      return this._consume().then(function (bytes) {
        return JSON.parse(bytesToText(bytes));
      });
    }
    arrayBuffer() {
      return this._consume().then(function (bytes) {
        if (bytes === null || bytes === undefined) return new ArrayBuffer(0);
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return copy.buffer;
      });
    }
    bytes() {
      return this._consume().then(function (bytes) {
        if (bytes === null || bytes === undefined) return new Uint8Array(0);
        var copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return copy;
      });
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
      if (this.bodyUsed) throw new TypeError('Response body is already used');
      var clonedBody;
      if (this._bodyStream) {
        // Tee the live stream so both responses can be read independently.
        var branches = this._bodyStream.tee();
        this._bodyStream = branches[0];
        clonedBody = branches[1];
      } else {
        // In-memory body: share the Uint8Array (all reads are non-mutating —
        // text/json, and arrayBuffer/bytes copy out).
        clonedBody = this._bodyBytes;
      }
      return new Response(clonedBody, {
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

  // isStreamLikeBody recognizes a request body that cannot be turned into bytes
  // synchronously: a Blob, a ReadableStream (anything with getReader), or an async
  // iterable. These are collected asynchronously in fetch() before the request is
  // sent (see the v1 limitation note in reference/node-compatibility.md).
  function isStreamLikeBody(b) {
    if (b === null || b === undefined || typeof b === 'string') return false;
    if (b instanceof Uint8Array || b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return false;
    if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
    if (typeof b.getReader === 'function') return true;
    if (typeof b[Symbol.asyncIterator] === 'function') return true;
    return false;
  }

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

      // A streaming body (Blob / ReadableStream / async iterable) is held as-is
      // and materialized to bytes in fetch(); only buffered bodies go to Body.
      var streamBody = bodyInit != null && isStreamLikeBody(bodyInit) ? bodyInit : null;
      if (streamBody) {
        super(null);
        this._streamBody = streamBody;
        // Node requires duplex:'half' for a ReadableStream / async-iterable body;
        // a Blob is a known-length body and is exempt.
        this._streamNeedsDuplex = !(typeof Blob !== 'undefined' && streamBody instanceof Blob);
      } else {
        super(bodyInit);
        this._streamBody = null;
        this._streamNeedsDuplex = false;
      }

      this.url = src ? src.url : input == null ? '' : String(input);
      var method = init.method !== undefined ? init.method : src ? src.method : 'GET';
      this.method = String(method || 'GET').toUpperCase();
      // A GET/HEAD request cannot carry a body, whether that body came from
      // init or was inherited from a source Request (WHATWG fetch).
      if (
        (this.method === 'GET' || this.method === 'HEAD') &&
        (this._bodyBytes != null || this._streamBody)
      ) {
        throw new TypeError('Request with GET/HEAD method cannot have body.');
      }
      var headersInit = init.headers !== undefined ? init.headers : src ? src.headers : undefined;
      this.headers = new Headers(headersInit);
    }
  }

  // collectStreamBody materializes a streaming request body to a single Uint8Array.
  // v1 buffers the whole body before sending (Content-Length framing); true
  // chunked upload is a tracked follow-up.
  async function collectStreamBody(src) {
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
      return new Uint8Array(await src.arrayBuffer());
    }
    var chunks = [];
    if (typeof src.getReader === 'function') {
      var reader = src.getReader();
      for (;;) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(chunkToBytes(r.value));
      }
    } else {
      for await (var chunk of src) chunks.push(chunkToBytes(chunk));
    }
    var bytes = concatChunks(chunks);
    return bytes === null ? new Uint8Array(0) : bytes;
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
  // loop, so the returned promise resolves on a later tick. http:// and https://
  // (TLS) are both wired; other schemes reject from the native side.
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

    // A streaming request body (Blob / ReadableStream / async iterable) is
    // buffered to bytes before the request is sent (v1 limitation). Node requires
    // duplex:'half' for stream bodies; enforce it for parity.
    if (req._streamBody) {
      if (req._streamNeedsDuplex && (!init || init.duplex !== 'half')) {
        return Promise.reject(
          new TypeError('fetch: a streaming request body requires init.duplex to be "half"'),
        );
      }
      return collectStreamBody(req._streamBody).then(function (bytes) {
        return startFetch(req, headerLines, bytes, signal);
      });
    }
    return startFetch(req, headerLines, req._bodyBytes, signal);
  }

  // startFetch hands the materialized request to the Odin transport and wires its
  // streaming callbacks (see native.request in pkg/runtime/fetch.odin) to a
  // BodyStream. onResponse resolves the promise with a Response whose body streams
  // incrementally; onChunk/onEnd feed and finish that stream; onError rejects a
  // pre-headers failure.
  function startFetch(req, headerLines, body, signal) {
    return new Promise(function (resolve, reject) {
      var abortListener = null;
      var sink = { stream: null, ended: false, endErr: null };
      var handles = null;

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

        var bodyArg = null;
        if (raw.hasBody) {
          var stream = new BodyStream({
            pull: function () {
              if (handles && typeof handles.resume === 'function') handles.resume();
            },
            cancel: function () {
              if (handles && typeof handles.cancel === 'function') handles.cancel();
            },
          });
          sink.stream = stream;
          // A terminal signal that arrived before the stream existed (a fully
          // buffered, same-tick body) is replayed here.
          if (sink.ended) {
            if (sink.endErr != null) stream._error(new TypeError(String(sink.endErr)));
            else stream._close();
          }
          bodyArg = stream;
        }
        resolve(
          new Response(bodyArg, {
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

      // Per body chunk: enqueue and report whether to keep reading (backpressure).
      function onChunk(bytes) {
        if (sink.stream) {
          sink.stream._enqueue(bytes);
          return sink.stream._desiredSize > 0;
        }
        return true;
      }

      // Body complete: err == null closes the stream cleanly; a string errors it.
      function onEnd(err) {
        sink.ended = true;
        sink.endErr = err;
        if (sink.stream) {
          if (err != null) sink.stream._error(new TypeError(String(err)));
          else sink.stream._close();
        }
      }

      handles = native.request(
        req.method,
        req.url,
        headerLines,
        body,
        onResponse,
        onError,
        onChunk,
        onEnd,
      );

      if (signal) {
        abortListener = function () {
          cleanup();
          // Tear down the native transport without invoking onResponse/onError.
          if (handles && typeof handles.cancel === 'function') handles.cancel();
          // Pre-headers: reject the fetch promise. Post-headers (promise already
          // resolved): error the in-flight body stream with the abort reason.
          if (sink.stream) sink.stream._error(signal.reason);
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
