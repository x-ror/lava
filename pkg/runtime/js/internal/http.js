// node:http — minimal HTTP/1.1 SERVER (M2), modeled on Node's http.Server /
// IncomingMessage / ServerResponse. Built on node:net (the TCP layer) with the request
// HEAD parsed by the native picohttpparser bridge (http.odin parseRequest). M2 scope:
// parse the head, emit 'request' with method/url/headers and a Content-Length request
// body, and write a response with writeHead/write/end. A streamed response (write()
// before end(), unknown length) is sent with Transfer-Encoding: chunked; end(body) with
// a known length uses Content-Length. No keep-alive yet (every response sets
// Connection: close and ends the socket), chunked REQUEST bodies are still rejected
// (501), and there is no client (http.request/get). Those are later milestones.
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.parseRequest !== 'function') {
    throw new Error('node:http is unavailable on this platform');
  }

  var EventEmitter = require('events');
  var Buffer = require('buffer').Buffer;
  var net = require('net');

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
  function chunkFrame(buf) {
    return Buffer.concat([Buffer.from(buf.length.toString(16) + '\r\n', 'latin1'), buf, CRLF]);
  }

  // Incremental decoder for a Transfer-Encoding: chunked REQUEST body (untrusted input).
  // feed(bytes) emits decoded data to req via 'data', fires 'end' after the terminating
  // zero-length chunk (+ optional trailers), and calls onError() on malformed framing.
  // Hardened: the chunk-size line is length-bounded, and a non-hex or unsafe size is
  // rejected — data is sliced out incrementally, so a huge declared size never allocates.
  var MAX_CHUNK_SIZE_LINE = 64 * 1024;
  function makeChunkedDecoder(req, onError) {
    var buf = Buffer.alloc(0);
    var state = 'size'; // 'size' | 'data' | 'dataCRLF' | 'trailer'
    var remaining = 0;
    var done = false;

    function bad() {
      done = true;
      onError();
    }
    function finish() {
      done = true;
      if (!req._ended) {
        req._ended = true;
        req.complete = true;
        req.emit('end');
      }
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
            return finish();
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

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    // Validate the status code at the single serialization chokepoint — it may have been
    // set via writeHead OR assigned directly (res.statusCode = ...). Rejects a non-integer
    // / out-of-range / CRLF-bearing status that would otherwise inject into the status line.
    var code = validateStatusCode(this.statusCode);
    this.headersSent = true;
    var reason = this.statusMessage || STATUS_CODES[code] || '';
    checkInvalidChar(String(reason), 'statusMessage'); // no CRLF in the status line
    var head = 'HTTP/1.1 ' + code + ' ' + reason + '\r\n';
    // M2: no keep-alive — the response is delimited by the connection close.
    if (!this.hasHeader('connection')) head += 'Connection: close\r\n';
    for (var key in this._headers) {
      if (!Object.prototype.hasOwnProperty.call(this._headers, key)) continue;
      var h = this._headers[key];
      head += h.name + ': ' + h.value + '\r\n';
    }
    head += '\r\n';
    this.socket.write(Buffer.from(head, 'latin1'));
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
      this._flushHead();
    }
    if (!noBody && body && body.length) {
      this.socket.write(this._chunked ? chunkFrame(body) : body);
    }
    // Terminate a chunked body with the zero-length last chunk.
    if (this._chunked && !noBody) this.socket.write(LAST_CHUNK);
    this.finished = true;
    if (typeof cb === 'function') process.nextTick(cb);
    this.emit('finish');
    this.socket.end(); // M2: one request/response per connection
    return this;
  };

  // Per-connection request pipeline: accumulate bytes, parse the head with the native
  // bridge, emit 'request', then feed the Content-Length body to the IncomingMessage.
  function onConnection(server, socket) {
    var pending = Buffer.alloc(0);
    var lastLen = 0;
    var parsingHead = true;
    var req = null;
    var res = null;
    var bodyRemaining = 0; // Content-Length bytes still owed to req ('data'); 0 == no body
    var chunkedDecode = null; // set for a Transfer-Encoding: chunked request body
    var failed = false; // a fixed error response was sent; ignore further input

    function fail(code) {
      if (failed) return;
      failed = true;
      var reason = STATUS_CODES[code] || 'Error';
      socket.write(
        Buffer.from(
          'HTTP/1.1 ' + code + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          'latin1',
        ),
      );
      socket.end();
    }

    function feedBody(buf) {
      if (!req || req._ended) return;
      if (chunkedDecode) {
        chunkedDecode(buf);
        return;
      }
      if (bodyRemaining > 0 && buf && buf.length) {
        var take = buf.length < bodyRemaining ? buf.length : bodyRemaining;
        req.emit('data', buf.slice(0, take));
        bodyRemaining -= take;
      }
      if (bodyRemaining <= 0) {
        req._ended = true;
        req.complete = true;
        req.emit('end');
      }
    }

    socket.on('data', function (chunk) {
      if (failed) return;
      if (!parsingHead) {
        feedBody(chunk);
        return;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      var r = native.parseRequest(pending, lastLen);
      lastLen = pending.length;

      if (r.state === 'partial') {
        if (pending.length > MAX_HEAD) fail(431);
        return;
      }
      if (r.state === 'error') {
        fail(400);
        return;
      }
      // Enforce the head-size cap on completion too — the partial-branch check alone lets
      // a complete-but-oversized head through.
      if (r.consumed > MAX_HEAD) {
        fail(431);
        return;
      }

      parsingHead = false;
      req = new IncomingMessage(socket, r);
      res = new ServerResponse(socket, req.method, req.httpVersionMinor);

      // Body framing over untrusted input. Reject the request-smuggling vectors rather
      // than guessing:
      //   - Content-Length + Transfer-Encoding together -> 400 (CL.TE desync)
      //   - Transfer-Encoding present but not exactly "chunked" -> 501 (only chunked is
      //     supported; other transfer codings aren't)
      //   - Content-Length not a single all-DIGIT token (duplicate "5, 5", negative,
      //     "+5", non-numeric) -> 400
      // A chunked decode error mid-request destroys the connection if the response is
      // already committed, else sends a clean 400.
      var te = req.headers['transfer-encoding'];
      var clStr = req.headers['content-length'];
      if (te !== undefined) {
        if (clStr !== undefined) {
          fail(400);
          return;
        }
        if (!/^\s*chunked\s*$/i.test(te)) {
          fail(501);
          return;
        }
        chunkedDecode = makeChunkedDecoder(req, function () {
          if (res.headersSent) socket.destroy();
          else fail(400);
        });
      } else if (clStr !== undefined) {
        if (!/^\d+$/.test(clStr)) {
          fail(400);
          return;
        }
        bodyRemaining = parseInt(clStr, 10);
      }

      var bodyStart = pending.slice(r.consumed);
      pending = null;

      server.emit('request', req, res);
      // Deliver body bytes that arrived in the same read as the head on the NEXT tick, so
      // a handler that attaches its 'data'/'end' listeners in process.nextTick (not just
      // synchronously) still sees them. Body from later reads arrives via socket 'data' on
      // its own tick, after this. (Full Readable buffering is a later, streaming milestone.)
      process.nextTick(function () {
        feedBody(bodyStart);
      });
    });

    socket.on('end', function () {
      // Peer half-closed. If the head or a Content-Length body is still incomplete, the
      // request can never finish — answer 400 (Node's premature-EOF behavior). A request
      // already received (req._ended) whose response is in flight is left alone; a bare
      // idle connection that closes without sending anything just closes.
      if (failed) return;
      if (parsingHead) {
        if (pending && pending.length > 0) fail(400);
      } else if (req && !req._ended && (bodyRemaining > 0 || chunkedDecode)) {
        // Incomplete Content-Length body, or a chunked body that never reached its
        // terminating zero-chunk. If the response already started, drop the socket.
        if (res && res.headersSent) socket.destroy();
        else fail(400);
      }
    });

    socket.on('error', function () {}); // peer reset — drop quietly
  }

  function Server(options, requestListener) {
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    EventEmitter.call(this);
    var self = this;
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
