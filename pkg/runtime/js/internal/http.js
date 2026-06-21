// node:http — minimal HTTP/1.1 SERVER (M2), modeled on Node's http.Server /
// IncomingMessage / ServerResponse. Built on node:net (the TCP layer) with the request
// HEAD parsed by the native picohttpparser bridge (http.odin parseRequest). M2 scope:
// parse the head, emit 'request' with method/url/headers and a Content-Length request
// body, and write a response with writeHead/write/end. No keep-alive (every response
// sets Connection: close and ends the socket), no chunked request/response bodies, no
// client (http.request/get). Those are later milestones.
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
    var headers = {};
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
    if (/[\r\n]/.test(value)) {
      var e = new TypeError('Invalid character in ' + what);
      e.code = 'ERR_INVALID_CHAR';
      throw e;
    }
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

  function ServerResponse(socket, method) {
    EventEmitter.call(this);
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this.finished = false;
    this._headers = {}; // lowercased key -> { name, value }
    // A response to a HEAD request carries headers (incl. Content-Length) but NO body
    // (RFC 7230 §3.3.2). Suppress body writes while keeping the framing.
    this._isHead = method === 'HEAD';
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
    this.statusCode = statusCode;
    if (statusMessage) this.statusMessage = statusMessage;
    if (headers)
      for (var k in headers)
        if (Object.prototype.hasOwnProperty.call(headers, k)) this.setHeader(k, headers[k]);
    return this;
  };

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    this.headersSent = true;
    var reason = this.statusMessage || STATUS_CODES[this.statusCode] || '';
    checkInvalidChar(String(reason), 'statusMessage'); // no CRLF in the status line
    var head = 'HTTP/1.1 ' + this.statusCode + ' ' + reason + '\r\n';
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
    if (!this.headersSent) this._flushHead();
    if (!this._isHead && chunk && chunk.length) {
      this.socket.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk);
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
    if (!this.headersSent) {
      // Known full body and no explicit length → set Content-Length (clean framing).
      if (!this.hasHeader('content-length')) {
        this.setHeader('Content-Length', String(body ? body.length : 0));
      }
      this._flushHead();
    }
    if (!this._isHead && body && body.length) this.socket.write(body);
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
    var bodyRemaining = 0; // Content-Length bytes still owed to req ('data'); 0 == no body
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

      // Body framing over untrusted input. M2 frames by Content-Length only; reject the
      // request-smuggling vectors rather than guessing:
      //   - Transfer-Encoding present  -> 501 (chunked request bodies are a later
      //     milestone; CL+TE is a desync vector either way)
      //   - Content-Length not a single all-DIGIT token (duplicate "5, 5", negative,
      //     "+5", non-numeric) -> 400
      if (req.headers['transfer-encoding'] !== undefined) {
        fail(501);
        return;
      }
      var clStr = req.headers['content-length'];
      if (clStr !== undefined) {
        if (!/^\d+$/.test(clStr)) {
          fail(400);
          return;
        }
        bodyRemaining = parseInt(clStr, 10);
      } else {
        bodyRemaining = 0;
      }

      var res = new ServerResponse(socket, req.method);
      var bodyStart = pending.slice(r.consumed);
      pending = null;

      server.emit('request', req, res);
      feedBody(bodyStart); // deliver any body bytes already buffered; emits 'end' when done
    });

    socket.on('end', function () {
      // Peer half-closed. If the head or a Content-Length body is still incomplete, the
      // request can never finish — answer 400 (Node's premature-EOF behavior). A request
      // already received (req._ended) whose response is in flight is left alone; a bare
      // idle connection that closes without sending anything just closes.
      if (failed) return;
      if (parsingHead) {
        if (pending && pending.length > 0) fail(400);
      } else if (req && !req._ended && bodyRemaining > 0) {
        fail(400);
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
