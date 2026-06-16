// Fetch surface — Headers, Request, Response, and a global `fetch`. Installs
// the WHATWG globals (Node exposes them without a require). This is the pure-JS
// half: Headers/Request/Response/Body machinery lives here, exactly as Node
// keeps it in JS; the actual `http://` network transport is Odin-backed and
// reached through the `native` bindings (native.request), mirroring how
// crypto/buffer receive their Odin primitives as the factory's fourth argument.
(function (require, module, exports, native) {
  'use strict';

  // The public Web Streams implementation (js/internal/streams.js). fetch builds
  // response bodies and consumes request bodies through this same ReadableStream
  // type, so `response.body` is a real, standard ReadableStream — not a fetch-only
  // fork. The `_internal` helpers let the transport drive a stream's controller
  // (enqueue/close/error + desiredSize backpressure) without re-implementing the
  // controller plumbing here.
  var webStreams = require('node:stream/web');
  var ReadableStream = webStreams.ReadableStream;
  var streamInternal = webStreams._internal;

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
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code === 0 || code === 10 || code === 13) {
        throw new TypeError('Invalid header value for "' + name + '": "' + value + '"');
      }
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
    return value.replaceAll(/^[\r\n\t ]+|[\r\n\t ]+$/g, '');
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
  // many undelivered bytes are queued in the response ReadableStream, its
  // controller.desiredSize goes non-positive and the native transport pauses the
  // socket read until the consumer drains below it (backpressure).
  var BODY_HWM = 64 * 1024;

  // byteSizeAlgorithm sizes a queued response chunk by its byte length, so the
  // response-body high-water mark (BODY_HWM) is measured in bytes — the unit the
  // native transport pauses/resumes on.
  function byteSizeAlgorithm(chunk) {
    return chunk && chunk.byteLength ? chunk.byteLength : 0;
  }

  // makeTransportStream builds a response-body ReadableStream fed by the native
  // transport. It returns the public stream plus push handles the transport's
  // sink uses: enqueue(bytes) returns whether to keep reading (desiredSize > 0),
  // close() / error(err) settle the stream. enqueue/close are guarded because a
  // late chunk can arrive after the consumer cancelled (stream no longer
  // readable); the guard turns that into a harmless no-op rather than a throw.
  function makeTransportStream(hooks) {
    var captured = streamInternal.createReadableStreamWithController(
      {
        // pull resumes a paused socket read; a no-op when not paused, so it is
        // safe for the controller to call it on every drained read.
        pull: hooks.pull,
        cancel: hooks.cancel,
      },
      BODY_HWM,
      byteSizeAlgorithm,
    );
    var controller = captured.controller;
    return {
      stream: captured.stream,
      enqueue: function (bytes) {
        try {
          controller.enqueue(bytes);
        } catch {
          return false;
        }
        return controller.desiredSize > 0;
      },
      close: function () {
        try {
          controller.close();
        } catch {}
      },
      error: function (err) {
        controller.error(err);
      },
    };
  }

  // streamFromBytes wraps an in-memory body in a one-shot ReadableStream so .body
  // is a real ReadableStream (Node parity). Enqueuing happens inside start(),
  // which does not mark the stream disturbed, so merely reading `.body` does not
  // flip bodyUsed.
  function streamFromBytes(bytes) {
    return new ReadableStream({
      start: function (controller) {
        if (bytes !== null && bytes !== undefined && bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  // Body backs Request and Response. It holds EITHER an in-memory byte body
  // (_bodyBytes, the fast path for JS-constructed bodies and buffered request
  // bodies) OR a streaming body (_bodyStream, fed by the transport). The buffered
  // accessors (text/json/arrayBuffer/bytes) drain the stream when present, so
  // streaming and buffering share one consumption path and a body is consumed at
  // most once.
  class Body {
    constructor(bodyInit) {
      if (streamInternal.isReadableStream(bodyInit)) {
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
      // or absent init.body keeps the source Request's body. A source's body may
      // be a streaming body (held in _streamBody, with _bodyBytes null), so
      // inherit that too — otherwise fetch(new Request(req)) would silently send
      // an empty body. (v1 caveat: the stream reference is shared, not teed, so
      // fetching both the source and the derived request is not supported.)
      var initBodyGiven = init.body !== undefined && init.body !== null;
      var bodyInit = initBodyGiven
        ? init.body
        : src
          ? src._streamBody != null
            ? src._streamBody
            : src._bodyBytes
          : init.body;

      // A streaming body (Blob / ReadableStream / async iterable) is held as-is
      // and materialized to bytes in fetch(); only buffered bodies go to Body.
      var streamBody = bodyInit != null && isStreamLikeBody(bodyInit) ? bodyInit : null;
      if (streamBody) {
        super(null);
        this._streamBody = streamBody;
        // Node requires duplex:'half' for a ReadableStream / async-iterable body;
        // a Blob is a known-length body and is exempt. The check is at construction
        // (where the duplex option lives) — only for a NEW init.body stream; a body
        // inherited from a source Request was already validated when it was built.
        this._streamNeedsDuplex = !(typeof Blob !== 'undefined' && streamBody instanceof Blob);
        if (this._streamNeedsDuplex && initBodyGiven && init.duplex !== 'half') {
          throw new TypeError('fetch: a streaming request body requires init.duplex to be "half"');
        }
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

  // collectStreamBody materializes a known-length streaming body (a Blob) to a
  // single Uint8Array so it can be sent with Content-Length framing — matching
  // Node, which treats a Blob as a known-length body (no duplex required).
  // ReadableStream / async-iterable bodies do NOT come here: they stream
  // incrementally as Transfer-Encoding: chunked (see startFetch). An abort signal
  // is honored mid-read so an infinite/slow producer does not keep allocating
  // after the caller cancels.
  async function collectStreamBody(src, signal) {
    if (signal && signal.aborted) throw signal.reason;
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
      var ab = await src.arrayBuffer();
      if (signal && signal.aborted) throw signal.reason;
      return new Uint8Array(ab);
    }
    var chunks = [];
    if (typeof src.getReader === 'function') {
      var reader = src.getReader();
      // An abort can land while reader.read() is pending — for a slow or stalled
      // producer that next chunk may never arrive, so a between-reads
      // signal.aborted check can never wake it and fetch() would hang before the
      // transport even starts. Register a listener that cancels the reader:
      // cancel() both settles the in-flight read (as done, waking the loop) and
      // tears the underlying source down. The reader is always released on the
      // way out so a user-created stream is never left locked.
      var aborted = false;
      var onAbort = null;
      if (signal) {
        onAbort = function () {
          aborted = true;
          try {
            var canceled = reader.cancel(signal.reason);
            if (canceled && typeof canceled.catch === 'function') canceled.catch(function () {});
          } catch {}
        };
        signal.addEventListener('abort', onAbort);
      }
      try {
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          chunks.push(chunkToBytes(r.value));
        }
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
      // cancel() settles the pending read as done, so the loop exits normally on
      // abort; surface the abort reason rather than a truncated body.
      if (aborted) throw signal.reason;
    } else {
      for await (var chunk of src) {
        if (signal && signal.aborted) throw signal.reason;
        chunks.push(chunkToBytes(chunk));
      }
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

    // Request body framing:
    //   - A Blob is a known-length body — Node frames it with Content-Length — so
    //     it keeps the buffered fast path (collect to bytes, then send).
    //   - A ReadableStream / async-iterable body (the ones that required
    //     duplex:'half') is streamed incrementally as Transfer-Encoding: chunked,
    //     never materialized in full (true upload streaming).
    // The duplex:'half' requirement was already enforced at Request construction;
    // _streamNeedsDuplex is false for a Blob and true for the stream-like bodies.
    if (req._streamBody) {
      if (!req._streamNeedsDuplex) {
        return collectStreamBody(req._streamBody, signal).then(function (bytes) {
          return startFetch(req, headerLines, bytes, null, signal);
        });
      }
      return startFetch(req, headerLines, null, req._streamBody, signal);
    }
    return startFetch(req, headerLines, req._bodyBytes, null, signal);
  }

  // startFetch hands the request to the Odin transport and wires its streaming
  // callbacks (see native.request in pkg/runtime/fetch.odin) to a public
  // ReadableStream. onResponse resolves the promise with a Response whose body
  // streams incrementally; onChunk/onEnd feed and finish that stream; onError
  // rejects a pre-headers failure.
  //
  // streamSource (optional) is a ReadableStream / async-iterable request body that
  // is streamed incrementally (Transfer-Encoding: chunked) rather than buffered:
  // the native side pulls one chunk at a time by invoking onBodyDrain, the pump
  // reads the producer and hands each chunk back through handles.pushBody, and
  // signals completion (or a producer error) through handles.endBody. The pull/push
  // protocol holds at most one chunk in flight, so socket write backpressure (the
  // native side defers onBodyDrain until the socket drains) pauses the producer.
  function startFetch(req, headerLines, body, streamSource, signal) {
    return new Promise(function (resolve, reject) {
      var abortListener = null;
      // sink.body is the makeTransportStream handle (enqueue/close/error +
      // .stream) once the response head has arrived; null while still pending.
      var sink = { body: null, ended: false, endErr: null };
      var handles = null;

      // --- request-body producer pump (streamSource only) ---
      var bodyReader = null; // ReadableStream reader, if the source is one
      var bodyIterator = null; // async iterator, otherwise
      var producing = false; // a producer read is in flight
      var producerDone = false; // producer finished, errored, or was torn down

      function setupProducer() {
        if (!streamSource) return;
        if (typeof streamSource.getReader === 'function') {
          bodyReader = streamSource.getReader();
        } else {
          bodyIterator = streamSource[Symbol.asyncIterator]();
        }
      }

      function readNextChunk() {
        return bodyReader ? bodyReader.read() : bodyIterator.next();
      }

      function cancelProducer(reason) {
        producerDone = true;
        try {
          if (bodyReader && typeof bodyReader.cancel === 'function') bodyReader.cancel(reason);
          else if (bodyIterator && typeof bodyIterator.return === 'function') bodyIterator.return();
        } catch (e) {}
      }

      // failProducer aborts the request: cancel the source and tell the native side
      // to tear the in-flight upload down (which rejects the fetch promise).
      function failProducer(err) {
        if (producerDone) return;
        cancelProducer(err);
        var msg =
          err && err.message ? err.message : err === undefined ? 'request body error' : String(err);
        if (handles && typeof handles.endBody === 'function') handles.endBody(msg);
      }

      // pumpBody pulls exactly one chunk from the producer and pushes it to the
      // native transport. The native side calls onBodyDrain to request the next
      // one once the current chunk has drained to the socket (backpressure).
      function pumpBody() {
        if (producing || producerDone) return;
        producing = true;
        var p;
        try {
          p = readNextChunk();
        } catch (e) {
          producing = false;
          failProducer(e);
          return;
        }
        Promise.resolve(p).then(
          function (res) {
            producing = false;
            if (producerDone) return;
            if (res.done) {
              producerDone = true;
              if (handles && typeof handles.endBody === 'function') handles.endBody(null);
              return;
            }
            var bytes;
            try {
              bytes = chunkToBytes(res.value);
            } catch (e) {
              failProducer(e);
              return;
            }
            // An empty chunk frames to nothing on the wire (and a zero-size chunk
            // would be read as the terminator), so skip it and pull the next.
            if (bytes.length === 0) {
              pumpBody();
              return;
            }
            if (handles && typeof handles.pushBody === 'function') handles.pushBody(bytes);
          },
          function (err) {
            producing = false;
            failProducer(err);
          },
        );
      }

      function onBodyDrain() {
        pumpBody();
      }

      function cleanup() {
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
        producerDone = true; // the request settled — stop pumping the producer
      }

      function onResponse(raw) {
        // NB: do NOT remove the abort listener here. The promise resolves at the
        // head, but the body is still streaming — an abort after headers must
        // still tear the transport down and error the body stream. cleanup runs
        // when the body settles (onEnd), fails (onError), or is cancelled.
        var headers = new Headers();
        var pairs = raw.headers || [];
        for (var i = 0; i + 1 < pairs.length; i += 2) headers._append(pairs[i], pairs[i + 1]);

        var bodyArg = null;
        if (raw.hasBody) {
          var bodyHandle = makeTransportStream({
            pull: function () {
              if (handles && typeof handles.resume === 'function') handles.resume();
            },
            cancel: function () {
              cleanup();
              if (handles && typeof handles.cancel === 'function') handles.cancel();
            },
          });
          sink.body = bodyHandle;
          // A terminal signal that arrived before the stream existed (a fully
          // buffered, same-tick body) is replayed here.
          if (sink.ended) {
            if (sink.endErr != null) bodyHandle.error(new TypeError(String(sink.endErr)));
            else bodyHandle.close();
          }
          bodyArg = bodyHandle.stream;
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
      // enqueue() already maps a non-positive desiredSize (or a closed/cancelled
      // stream) to false, so the transport pauses or stops as appropriate.
      function onChunk(bytes) {
        if (sink.body) return sink.body.enqueue(bytes);
        return true;
      }

      // Body complete: err == null closes the stream cleanly; a string errors it.
      function onEnd(err) {
        cleanup(); // body settled — abort can no longer affect it
        sink.ended = true;
        sink.endErr = err;
        if (sink.body) {
          if (err != null) sink.body.error(new TypeError(String(err)));
          else sink.body.close();
        }
      }

      // Acquire the producer reader before starting the transport so a locked /
      // unusable stream rejects this promise synchronously (executor throw) rather
      // than after the request is already in flight.
      setupProducer();

      handles = native.request(
        req.method,
        req.url,
        headerLines,
        body,
        onResponse,
        onError,
        onChunk,
        onEnd,
        streamSource ? true : false,
        streamSource ? onBodyDrain : null,
      );

      if (signal) {
        abortListener = function () {
          cleanup();
          // Stop the producer and tear down the native transport without invoking
          // onResponse/onError.
          cancelProducer(signal.reason);
          if (handles && typeof handles.cancel === 'function') handles.cancel();
          // Pre-headers: reject the fetch promise. Post-headers (promise already
          // resolved): error the in-flight body stream with the abort reason.
          if (sink.body) sink.body.error(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abortListener);
      }
    });
  }

  if (globalThis.Headers === undefined) globalThis.Headers = Headers;
  if (globalThis.Request === undefined) globalThis.Request = Request;
  if (globalThis.Response === undefined) globalThis.Response = Response;
  if (globalThis.fetch === undefined) globalThis.fetch = fetch;

  module.exports = { fetch: fetch, Headers: Headers, Request: Request, Response: Response };
});
