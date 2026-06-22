// node:http — minimal HTTP/1.1 SERVER (M2), modeled on Node's http.Server /
// IncomingMessage / ServerResponse. Built on node:net (the TCP layer) with the request
// HEAD parsed by the native picohttpparser bridge (http.odin parseRequest). M2 scope:
// parse the head, emit 'request' with method/url/headers and a Content-Length request
// body, and write a response with writeHead/write/end. A streamed response (write()
// before end(), unknown length) is sent with Transfer-Encoding: chunked; end(body) with
// a known length uses Content-Length. Keep-alive is supported: a connection is reused
// for subsequent requests (HTTP/1.1 default; HTTP/1.0 with Connection: keep-alive) when
// the response is self-delimiting, and closed otherwise. Chunked request bodies are
// decoded. Slowloris/idle defenses bound time-to-headers, time-to-full-request, and idle
// keep-alive gaps (server.headersTimeout / requestTimeout / keepAliveTimeout). There is
// no client (http.request/get) yet — that is a later milestone.
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.parseRequest !== 'function') {
    throw new Error('node:http is unavailable on this platform');
  }

  var EventEmitter = require('events');
  var Buffer = require('buffer').Buffer;
  var net = require('net');
  // Pristine intrinsics (captured before any user code) for serializing the response head:
  // the hot path must not route bytes through public Buffer/Uint8Array methods, which a
  // script can override (prototype pollution) to corrupt the head or — via a lying
  // allocUnsafe — leak uninitialized memory past the body. See writeLatin1Into / headBytes.
  var P = require('primordials');

  var MAX_HEAD = 64 * 1024; // reject a request head larger than this (431)

  var STATUS_CODES = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    206: 'Partial Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    307: 'Temporary Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    411: 'Length Required',
    413: 'Payload Too Large',
    414: 'URI Too Long',
    431: 'Request Header Fields Too Large',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    503: 'Service Unavailable',
  };

  // Build Node's lowercased req.headers object from the interleaved [name, value, ...]
  // array the parser returns. Duplicates join with ', ' (Node's behavior for most
  // headers; set-cookie's array form is out of M2 scope).
  function buildHeaders(arr) {
    // Null prototype: a header literally named "constructor"/"hasOwnProperty"/etc. must
    // not collide with Object.prototype (which would corrupt the duplicate-merge check).
    var headers = Object.create(null);
    for (var i = 0; i + 1 < arr.length; i += 2) {
      var k = arr[i].toLowerCase();
      var v = arr[i + 1];
      if (headers[k] === undefined) headers[k] = v;
      else headers[k] += ', ' + v;
    }
    return headers;
  }

  // RFC 7230 token (header field-name) and the CR/LF guard for field-values / the status
  // reason. Reject invalid input rather than concatenating it into the response head —
  // a value containing CRLF would otherwise split the response (header injection).
  var TOKEN_RE = /^[\^_`a-zA-Z0-9!#$%&'*+\-.|~]+$/;
  // A field-value/reason char outside this set is rejected. Crucially this also bans code
  // points > 0xFF: _flushHead serializes with Buffer.from(head, 'latin1'), which masks
  // each char to one byte, so e.g. č/Ċ would become CR/LF and reintroduce
  // response splitting past a naive /[\r\n]/ check. Mirrors Node's checkInvalidHeaderChar
  // (allow HT, printable ASCII, and the latin1 high range 0x80-0xFF).
  var INVALID_HEADER_CHAR_RE = /[^\t\x20-\x7e\x80-\xff]/;
  function checkHeaderName(name) {
    if (typeof name !== 'string' || name.length === 0 || !TOKEN_RE.test(name)) {
      var e = new TypeError(
        'Header name must be a valid HTTP token [' + JSON.stringify(name) + ']',
      );
      e.code = 'ERR_INVALID_HTTP_TOKEN';
      throw e;
    }
  }
  function checkInvalidChar(value, what) {
    if (INVALID_HEADER_CHAR_RE.test(value)) {
      var e = new TypeError('Invalid character in ' + what);
      e.code = 'ERR_INVALID_CHAR';
      throw e;
    }
  }

  // 204/304 and 1xx carry no message body (RFC 7230 §3.3.2); HEAD responses also omit
  // the body (but keep Content-Length).
  function statusHasNoBody(code) {
    return code === 204 || code === 304 || (code >= 100 && code < 200);
  }
  function validateStatusCode(code) {
    var n = Number(code);
    if (!Number.isInteger(n) || n < 100 || n > 999) {
      var e = new RangeError('Invalid status code: ' + JSON.stringify(code));
      e.code = 'ERR_HTTP_INVALID_STATUS_CODE';
      throw e;
    }
    return n;
  }

  // Frame a body chunk for Transfer-Encoding: chunked — "<hex-length>\r\n<data>\r\n".
  // A zero-length chunk is never framed (the caller skips empty writes); the terminating
  // "0\r\n\r\n" is written explicitly by end().
  var CRLF = Buffer.from('\r\n', 'latin1');
  var LAST_CHUNK = Buffer.from('0\r\n\r\n', 'latin1');
  // Upper bound for coalescing the response head with end()'s body into a single write: a
  // small body is concatenated to the head (one send() instead of two), but a large one is
  // written separately so we don't memcpy a big payload just to save one syscall.
  var HEAD_COALESCE_MAX = 64 * 1024;

  // writeLatin1Into writes `str`'s latin1 bytes into `dst` starting at `offset`, using only
  // pristine intrinsics: a typed-array index store (a native operation, not a method, so it
  // can't be overridden) and the captured StringPrototypeCharCodeAt. Masking to a byte
  // matches Buffer.from(str, 'latin1') for code points > 0xFF.
  function writeLatin1Into(dst, str, offset) {
    for (var i = 0; i < str.length; i++) {
      dst[offset + i] = P.StringPrototypeCharCodeAt(str, i) & 0xff;
    }
  }
  // headBytes serializes a latin1 head string into a fresh, pristine, zero-filled Uint8Array
  // (the pristine constructor honors the exact length, and the bytes are fully overwritten —
  // no overridable allocator, no uninitialized-memory disclosure).
  function headBytes(str) {
    var out = new P.Uint8Array(str.length);
    writeLatin1Into(out, str, 0);
    return out;
  }
  function chunkFrame(buf) {
    return Buffer.concat([Buffer.from(buf.length.toString(16) + '\r\n', 'latin1'), buf, CRLF]);
  }

  // Incremental decoder for a Transfer-Encoding: chunked REQUEST body (untrusted input).
  // feed(bytes) emits decoded data to req via 'data' and, after the terminating zero-length
  // chunk (+ optional trailers), calls onEnd(leftover) with any bytes past the body (the
  // next pipelined request, for keep-alive). onError() is called on malformed framing.
  // Hardened: the chunk-size line is length-bounded, a non-hex / unsafe / whitespace-laden
  // size is rejected, and data is sliced out incrementally so a huge declared size never
  // allocates.
  var MAX_CHUNK_SIZE_LINE = 64 * 1024;
  function makeChunkedDecoder(req, onError, onEnd) {
    var buf = Buffer.alloc(0);
    var state = 'size'; // 'size' | 'data' | 'dataCRLF' | 'trailer'
    var remaining = 0;
    var done = false;

    function bad() {
      done = true;
      onError();
    }

    return function feed(incoming) {
      if (done) return;
      if (incoming && incoming.length) buf = buf.length ? Buffer.concat([buf, incoming]) : incoming;
      for (;;) {
        if (state === 'size') {
          var nl = buf.indexOf('\r\n');
          if (nl < 0) {
            if (buf.length > MAX_CHUNK_SIZE_LINE) bad();
            return;
          }
          if (nl > MAX_CHUNK_SIZE_LINE) return bad(); // over-long size line, even with CRLF
          var line = buf.toString('latin1', 0, nl);
          // Strict chunk-size grammar: chunk-size = 1*HEXDIG (no surrounding whitespace),
          // optionally followed by ";" chunk-ext. A lenient parser that accepts "5 ",
          // " 5", or "5;" (empty ext) could disagree with a frontend proxy on the body
          // boundary — a smuggling surface — so reject those (Node does too).
          var semi = line.indexOf(';');
          var sizePart = semi >= 0 ? line.slice(0, semi) : line;
          if (!/^[0-9a-fA-F]+$/.test(sizePart)) return bad();
          if (semi >= 0 && !/^;[^\s;]/.test(line.slice(semi))) return bad(); // ext must start with a token char
          var size = parseInt(sizePart, 16);
          if (!Number.isSafeInteger(size) || size < 0) return bad();
          buf = buf.slice(nl + 2);
          if (size === 0) state = 'trailer';
          else {
            remaining = size;
            state = 'data';
          }
        } else if (state === 'data') {
          if (buf.length === 0) return;
          var take = buf.length < remaining ? buf.length : remaining;
          req.emit('data', buf.slice(0, take));
          buf = buf.slice(take);
          remaining -= take;
          if (remaining === 0) state = 'dataCRLF';
        } else if (state === 'dataCRLF') {
          if (buf.length < 2) return;
          if (buf[0] !== 13 || buf[1] !== 10) return bad(); // chunk must end in CRLF
          buf = buf.slice(2);
          state = 'size';
        } else {
          // 'trailer': optional trailer header lines, then a blank line (CRLF) ends the body.
          if (buf.length < 2) return;
          if (buf[0] === 13 && buf[1] === 10) {
            buf = buf.slice(2);
            done = true;
            return onEnd(buf); // body complete; hand back any pipelined leftover
          }
          var tnl = buf.indexOf('\r\n');
          if (tnl < 0) {
            if (buf.length > MAX_CHUNK_SIZE_LINE) bad();
            return;
          }
          if (tnl > MAX_CHUNK_SIZE_LINE) return bad();
          // A trailer must be a well-formed header field ("token: value"); reject garbage
          // like "0\r\nBadTrailer\r\n\r\n" instead of treating it as a valid end-of-body.
          var tline = buf.toString('latin1', 0, tnl);
          var tc = tline.indexOf(':');
          if (tc <= 0 || !TOKEN_RE.test(tline.slice(0, tc))) return bad();
          buf = buf.slice(tnl + 2); // drop the (valid) trailer line; loop for the next / blank line
        }
      }
    };
  }

  function IncomingMessage(socket, parsed) {
    EventEmitter.call(this);
    this.socket = socket;
    this.method = parsed.method;
    this.url = parsed.url;
    this.httpVersionMajor = 1;
    this.httpVersionMinor = parsed.minor;
    this.httpVersion = '1.' + parsed.minor;
    this.rawHeaders = parsed.headers.slice();
    this.headers = buildHeaders(parsed.headers);
    this.complete = false;
    this._ended = false;
  }
  IncomingMessage.prototype = Object.create(EventEmitter.prototype);
  IncomingMessage.prototype.constructor = IncomingMessage;

  function ServerResponse(socket, method, httpMinor) {
    EventEmitter.call(this);
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this._chunked = false; // emitting Transfer-Encoding: chunked (streamed, unknown length)
    this.finished = false;
    this._headers = {}; // lowercased key -> { name, value }
    // A response to a HEAD request carries headers (incl. Content-Length) but NO body
    // (RFC 7230 §3.3.2). Suppress body writes while keeping the framing.
    this._isHead = method === 'HEAD';
    // HTTP/1.0 has no Transfer-Encoding: chunked — such a client would read the chunk-size
    // markers as body. For a 1.0 request, stream raw bytes delimited by the connection
    // close (we already send Connection: close) instead of chunking. Undefined minor
    // (direct construction) defaults to allowing chunked (HTTP/1.1).
    this._allowChunked = httpMinor === undefined || httpMinor >= 1;
    // Tentative keep-alive (from the request); _flushHead finalizes it once the response
    // framing is known (a non-self-delimiting response can't keep-alive). The connection
    // reads the finalized value after 'finish' to decide whether to reuse the socket.
    this._keepAlive = false;
    this._onComplete = null; // connection-supplied: called by end() instead of closing
  }
  ServerResponse.prototype = Object.create(EventEmitter.prototype);
  ServerResponse.prototype.constructor = ServerResponse;

  ServerResponse.prototype.setHeader = function (name, value) {
    checkHeaderName(name);
    var v = String(value);
    checkInvalidChar(v, 'header content [' + name + ']');
    this._headers[name.toLowerCase()] = { name: name, value: v };
    return this;
  };
  ServerResponse.prototype.getHeader = function (name) {
    var h = this._headers[String(name).toLowerCase()];
    return h ? h.value : undefined;
  };
  ServerResponse.prototype.removeHeader = function (name) {
    delete this._headers[String(name).toLowerCase()];
  };
  ServerResponse.prototype.hasHeader = function (name) {
    return Object.prototype.hasOwnProperty.call(this._headers, String(name).toLowerCase());
  };

  ServerResponse.prototype.writeHead = function (statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = validateStatusCode(statusCode);
    if (statusMessage) this.statusMessage = statusMessage;
    if (headers)
      for (var k in headers)
        if (Object.prototype.hasOwnProperty.call(headers, k)) this.setHeader(k, headers[k]);
    return this;
  };

  // _buildHead serializes the status line + headers (finalizing keep-alive) and returns the
  // head as a latin1 string. It deliberately does NOT set headersSent or write anything:
  // the caller flips headersSent only immediately before it actually writes, so a throw or
  // allocation failure between build and write (e.g. coalescing a body) cannot leave the
  // response falsely marked as sent and poison error recovery / the keep-alive connection.
  ServerResponse.prototype._buildHead = function () {
    // Validate the status code at the single serialization chokepoint — it may have been
    // set via writeHead OR assigned directly (res.statusCode = ...). Rejects a non-integer
    // / out-of-range / CRLF-bearing status that would otherwise inject into the status line.
    var code = validateStatusCode(this.statusCode);
    var reason = this.statusMessage || STATUS_CODES[code] || '';
    checkInvalidChar(String(reason), 'statusMessage'); // no CRLF in the status line
    var head = 'HTTP/1.1 ' + code + ' ' + reason + '\r\n';
    // Finalize keep-alive: only possible if the response is self-delimiting (Content-Length,
    // chunked, or a no-body status/HEAD) — otherwise the body ends at connection close, so
    // we must close. A handler-set "Connection: close" also wins.
    var selfDelimited =
      this._chunked ||
      this.hasHeader('content-length') ||
      this._isHead ||
      statusHasNoBody(this.statusCode);
    if (!selfDelimited) this._keepAlive = false;
    if (this.hasHeader('connection')) {
      if (/\bclose\b/i.test(this.getHeader('connection'))) this._keepAlive = false;
    } else {
      head += this._keepAlive ? 'Connection: keep-alive\r\n' : 'Connection: close\r\n';
    }
    for (var key in this._headers) {
      if (!Object.prototype.hasOwnProperty.call(this._headers, key)) continue;
      var h = this._headers[key];
      head += h.name + ': ' + h.value + '\r\n';
    }
    head += '\r\n';
    return head;
  };

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    // Build the head bytes BEFORE flipping headersSent, so a serialization/allocation failure
    // can't leave the response marked sent with nothing written.
    var buf = headBytes(this._buildHead());
    this.headersSent = true;
    this.socket.write(buf);
  };

  ServerResponse.prototype.write = function (chunk, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    var noBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      // A write() before end() with no explicit length is a streamed body of unknown
      // size → frame it with Transfer-Encoding: chunked (self-delimiting; also what
      // keep-alive will need). end(body) without a prior write still uses Content-Length.
      // No-body responses (HEAD/204/304/1xx) never get a body or chunked framing; neither
      // does an HTTP/1.0 client (it would mis-read the chunk markers) — it gets raw,
      // close-delimited bytes.
      if (
        !noBody &&
        this._allowChunked &&
        !this.hasHeader('content-length') &&
        !this.hasHeader('transfer-encoding')
      ) {
        this._chunked = true;
        this.setHeader('Transfer-Encoding', 'chunked');
      } else if (this._allowChunked && this.hasHeader('transfer-encoding')) {
        this._chunked = /\bchunked\b/i.test(this.getHeader('transfer-encoding'));
      }
      this._flushHead();
    }
    if (!noBody && chunk && chunk.length) {
      var b = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
      this.socket.write(this._chunked ? chunkFrame(b) : b);
    }
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };

  ServerResponse.prototype.end = function (chunk, encoding, cb) {
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (this.finished) return this;

    var body = null;
    if (chunk !== undefined && chunk !== null) {
      body = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
    }
    // 204/304/1xx carry no body and no Content-Length; HEAD keeps Content-Length but
    // sends no body; everything else frames by the body length.
    var noBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      // No prior write() → we know the full length here, so frame with Content-Length
      // (unless a no-body status, or the caller already chose Transfer-Encoding).
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && !noBody) {
        this.setHeader('Content-Length', String(body ? body.length : 0));
      }
      if (this._allowChunked && this.hasHeader('transfer-encoding')) {
        this._chunked = /\bchunked\b/i.test(this.getHeader('transfer-encoding'));
      }
      // Fast path: emit the head and a known, non-chunked body in ONE socket write (one
      // send() instead of two — the response write path was ~33% of CPU on a hello-world
      // server, half of it the extra syscall). Conditions:
      //   - body is a Uint8Array/Buffer (so length == byteLength and the copy below is
      //     byte-exact; anything else takes the separate path unchanged, never the throwing
      //     concat), and
      //   - the COMBINED size (head + body) is within the bound — guarding the head too, so
      //     a large header can't blow up the merged allocation.
      // headersSent flips only after the buffer is fully built, so a build/alloc failure
      // can't leave the response falsely marked sent.
      var head = this._buildHead();
      var total = head.length + (body ? body.length : 0); // head is latin1: length == bytes
      if (
        !noBody &&
        body &&
        body.length &&
        body instanceof P.Uint8Array &&
        !this._chunked &&
        total <= HEAD_COALESCE_MAX
      ) {
        // Build the combined buffer with pristine ops only (zero-filled Uint8Array, captured
        // charCodeAt, uncurried set) and fully overwrite all `total` bytes, so a polluted
        // Buffer.allocUnsafe/write/set can neither corrupt the head nor leak uninitialized
        // bytes past the body. Then flip headersSent immediately before the write.
        var out = new P.Uint8Array(total);
        writeLatin1Into(out, head, 0);
        P.Uint8ArrayPrototypeSet(out, body, head.length);
        this.headersSent = true;
        this.socket.write(out);
        body = null; // written with the head
      } else {
        var hb = headBytes(head);
        this.headersSent = true;
        this.socket.write(hb);
      }
    }
    if (!noBody && body && body.length) {
      this.socket.write(this._chunked ? chunkFrame(body) : body);
    }
    // Terminate a chunked body with the zero-length last chunk.
    if (this._chunked && !noBody) this.socket.write(LAST_CHUNK);
    this.finished = true;
    if (typeof cb === 'function') process.nextTick(cb);
    this.emit('finish');
    // The connection decides what happens next (reuse the socket on keep-alive, or close);
    // a directly-constructed response with no connection falls back to closing.
    if (this._onComplete) this._onComplete();
    else this.socket.end();
    return this;
  };

  function shouldKeepAlive(req) {
    var conn = (req.headers['connection'] || '').toLowerCase();
    // HTTP/1.1 defaults to keep-alive (unless "close"); HTTP/1.0 defaults to close
    // (unless "keep-alive"). _flushHead further forces close for a non-self-delimiting
    // response.
    if (req.httpVersionMinor >= 1) return !/\bclose\b/.test(conn);
    return /\bkeep-alive\b/.test(conn);
  }

  // Per-connection request loop: parse a head, emit 'request', feed the body, and — once
  // BOTH the body is fully consumed and the response is finished — either reuse the socket
  // for the next request (keep-alive) or close it. Leftover bytes past a body (a pipelined
  // next request) are carried in `pending`.
  function onConnection(server, socket) {
    var pending = Buffer.alloc(0);
    var lastLen = 0;
    var parsingHead = true;
    var req = null;
    var res = null;
    var bodyRemaining = 0; // Content-Length bytes still owed to req ('data')
    var chunkedDecode = null; // decoder for a Transfer-Encoding: chunked request body
    var bodyDone = false; // request body fully received ('end' fired)
    var resDone = false; // response fully sent ('finish' fired)
    var peerEnded = false; // peer half-closed (read EOF) — no more requests will arrive
    var closed = false; // socket is being torn down; ignore further input

    // Slowloris / idle defenses (see Server). idleTimer guards the gap before a request;
    // headersTimer/requestTimer bound how long receiving a request's head / whole body may
    // take once it has started.
    var keepAliveMs = server.keepAliveTimeout || 0;
    var headersMs = server.headersTimeout || 0;
    var requestMs = server.requestTimeout || 0;
    var idleTimer = null;
    var headersTimer = null;
    var requestTimer = null;
    var requestActive = false; // a request is currently being received (head or body)

    function clearReqTimers() {
      if (headersTimer) {
        clearTimeout(headersTimer);
        headersTimer = null;
      }
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
    }
    function clearTimers() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      clearReqTimers();
    }
    function destroyConn() {
      if (closed) return;
      closed = true;
      clearTimers();
      socket.destroy();
    }
    function armIdle() {
      if (keepAliveMs > 0)
        idleTimer = setTimeout(function () {
          destroyConn(); // idle too long between requests — drop it
        }, keepAliveMs);
    }
    function beginRequestTimers() {
      requestActive = true;
      if (headersMs > 0) headersTimer = setTimeout(onReqTimeout, headersMs);
      if (requestMs > 0) requestTimer = setTimeout(onReqTimeout, requestMs);
    }
    function onReqTimeout() {
      // A slow head or body (slowloris): answer 408 if no response has started, then close.
      if (closed) return;
      if (res && res.headersSent) destroyConn();
      else fail(408);
    }

    function fail(code) {
      if (closed) return;
      closed = true;
      clearTimers();
      var reason = STATUS_CODES[code] || 'Error';
      socket.write(
        Buffer.from(
          'HTTP/1.1 ' + code + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          'latin1',
        ),
      );
      socket.end();
    }

    function resetForNext() {
      parsingHead = true;
      lastLen = 0;
      req = null;
      res = null;
      bodyRemaining = 0;
      chunkedDecode = null;
      bodyDone = false;
      resDone = false;
      requestActive = false;
    }

    // Advance only when the request is fully read AND the response is fully sent. Then keep
    // the socket for the next request (per the finalized res._keepAlive) or close it.
    function maybeAdvance() {
      if (closed || !bodyDone || !resDone) return;
      if (!res._keepAlive) {
        closed = true;
        clearTimers();
        socket.end();
        return;
      }
      resetForNext();
      if (pending.length > 0) {
        beginRequestTimers(); // a pipelined next request is already buffered
        processHead();
      } else if (peerEnded) {
        // Kept alive, nothing buffered, and the peer already half-closed → no further
        // request can arrive (net no longer auto-closes on EOF), so close now.
        destroyConn();
      } else {
        armIdle(); // wait for the next request, bounded by keepAliveTimeout
      }
    }

    function onResComplete() {
      resDone = true;
      maybeAdvance();
    }

    // Body fully received: fire req 'end' once, stash any leftover (pipelined) bytes, advance.
    function onBodyComplete(leftover) {
      pending = leftover && leftover.length ? leftover : Buffer.alloc(0);
      clearReqTimers(); // the whole request is in; the response is not time-bounded
      if (req && !req._ended) {
        req._ended = true;
        req.complete = true;
        req.emit('end');
      }
      bodyDone = true;
      maybeAdvance();
    }

    // Content-Length body feed: emit up to bodyRemaining bytes, keep the rest as leftover.
    function feedBody(buf) {
      if (!req || req._ended) return;
      if (bodyRemaining > 0 && buf && buf.length) {
        var take = buf.length < bodyRemaining ? buf.length : bodyRemaining;
        req.emit('data', buf.slice(0, take));
        bodyRemaining -= take;
        buf = buf.slice(take);
      }
      if (bodyRemaining <= 0) onBodyComplete(buf);
    }

    function processHead() {
      var r = native.parseRequest(pending, lastLen);
      if (r.state === 'partial') {
        if (pending.length > MAX_HEAD) fail(431);
        else lastLen = pending.length;
        return;
      }
      if (r.state === 'error') return fail(400);
      if (r.consumed > MAX_HEAD) return fail(431);

      parsingHead = false;
      lastLen = 0;
      if (headersTimer) {
        clearTimeout(headersTimer); // head received within headersTimeout
        headersTimer = null;
      }
      req = new IncomingMessage(socket, r);
      res = new ServerResponse(socket, req.method, req.httpVersionMinor);
      res._keepAlive = shouldKeepAlive(req); // finalized in _flushHead
      res._onComplete = onResComplete;

      var bodyStart = pending.slice(r.consumed);
      pending = Buffer.alloc(0);

      // Body framing over untrusted input (smuggling-resistant): reject CL+TE (400), a TE
      // that isn't exactly chunked (501), and a non-DIGIT Content-Length (400). A chunked
      // decode error destroys the socket if the response already started, else sends 400.
      var te = req.headers['transfer-encoding'];
      var clStr = req.headers['content-length'];
      if (te !== undefined) {
        if (clStr !== undefined) return fail(400);
        if (!/^\s*chunked\s*$/i.test(te)) return fail(501);
        chunkedDecode = makeChunkedDecoder(
          req,
          function () {
            if (res.headersSent) destroyConn();
            else fail(400);
          },
          onBodyComplete,
        );
      } else if (clStr !== undefined) {
        if (!/^\d+$/.test(clStr)) return fail(400);
        bodyRemaining = parseInt(clStr, 10);
      }

      server.emit('request', req, res);
      // Deliver body bytes from the head's read on the NEXT tick, so a handler that attaches
      // 'data'/'end' in process.nextTick (not only synchronously) still sees them. For a
      // bodyless request this fires 'end' immediately (and surfaces any pipelined leftover).
      process.nextTick(function () {
        if (closed) return;
        if (chunkedDecode) chunkedDecode(bodyStart);
        else feedBody(bodyStart);
      });
    }

    socket.on('data', function (chunk) {
      if (closed) return;
      // First byte of a request: stop the idle timer and start the head/request timers.
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (!requestActive) beginRequestTimers();
      if (parsingHead) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        processHead();
      } else if (bodyDone) {
        // Body finished but we haven't advanced yet (the response is still being produced):
        // a pipelined next request must be BUFFERED, not handed to the now-finished body
        // consumer (which would drop it). It is re-parsed when we advance.
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      } else if (chunkedDecode) {
        chunkedDecode(chunk);
      } else {
        feedBody(chunk);
      }
    });

    socket.on('end', function () {
      peerEnded = true;
      // Defer one tick so the scheduled body delivery runs first — a client that writes a
      // COMPLETE request and immediately half-closes (socket.end(req)) would otherwise race
      // us into a false 400 before the request is marked complete.
      process.nextTick(function () {
        if (closed) return;
        if (parsingHead) {
          // A partial head that can no longer complete is a bad request; an idle keep-alive
          // connection the peer is done with just closes (net no longer auto-closes on EOF).
          if (pending.length > 0) fail(400);
          else destroyConn();
        } else if (req && !req._ended) {
          // Genuinely incomplete body (more bytes were expected) — premature EOF.
          if (res && res.headersSent) destroyConn();
          else fail(400);
        }
        // else: request complete, response in flight → res completion drives the close.
      });
    });

    socket.on('error', function () {
      // peer reset — clear timers and stop processing (the net layer frees the socket)
      closed = true;
      clearTimers();
    });

    // A freshly accepted connection that sends nothing must not pin the socket: bound the
    // wait for the first request by keepAliveTimeout (the same idle budget reused between
    // keep-alive requests).
    armIdle();
  }

  function Server(options, requestListener) {
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    EventEmitter.call(this);
    var self = this;
    // Slowloris / idle-connection defenses (ms; 0 disables). Node's defaults:
    //   keepAliveTimeout — idle time between requests on a kept-alive connection
    //   headersTimeout   — time to receive the complete request head
    //   requestTimeout   — time to receive the entire request (head + body)
    this.keepAliveTimeout = 5000;
    this.headersTimeout = 60000;
    this.requestTimeout = 300000;
    // Honor timeouts configured at construction (Node's createServer(options) form), not
    // only post-construction mutation.
    if (options && typeof options === 'object') {
      if (typeof options.keepAliveTimeout === 'number')
        this.keepAliveTimeout = options.keepAliveTimeout;
      if (typeof options.headersTimeout === 'number') this.headersTimeout = options.headersTimeout;
      if (typeof options.requestTimeout === 'number') this.requestTimeout = options.requestTimeout;
    }
    this._net = net.createServer(function (socket) {
      onConnection(self, socket);
    });
    this._net.on('listening', function () {
      self.emit('listening');
    });
    this._net.on('close', function () {
      self.emit('close');
    });
    this._net.on('error', function (e) {
      self.emit('error', e);
    });
    if (typeof requestListener === 'function') this.on('request', requestListener);
  }
  Server.prototype = Object.create(EventEmitter.prototype);
  Server.prototype.constructor = Server;

  Server.prototype.listen = function () {
    this._net.listen.apply(this._net, arguments);
    return this;
  };
  Server.prototype.close = function (cb) {
    this._net.close(cb);
    return this;
  };
  Server.prototype.address = function () {
    return this._net.address();
  };

  function createServer(options, requestListener) {
    return new Server(options, requestListener);
  }

  module.exports = {
    createServer: createServer,
    Server: Server,
    IncomingMessage: IncomingMessage,
    ServerResponse: ServerResponse,
    STATUS_CODES: STATUS_CODES,
  };
});
