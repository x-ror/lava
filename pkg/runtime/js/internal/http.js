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
    200: 'OK', 201: 'Created', 204: 'No Content', 206: 'Partial Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 408: 'Request Timeout', 411: 'Length Required',
    413: 'Payload Too Large', 414: 'URI Too Long', 431: 'Request Header Fields Too Large',
    500: 'Internal Server Error', 501: 'Not Implemented', 503: 'Service Unavailable',
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

  function ServerResponse(socket) {
    EventEmitter.call(this);
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this.finished = false;
    this._headers = {}; // lowercased key -> { name, value }
  }
  ServerResponse.prototype = Object.create(EventEmitter.prototype);
  ServerResponse.prototype.constructor = ServerResponse;

  ServerResponse.prototype.setHeader = function (name, value) {
    this._headers[String(name).toLowerCase()] = { name: String(name), value: String(value) };
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
    if (headers) for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) this.setHeader(k, headers[k]);
    return this;
  };

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    this.headersSent = true;
    var reason = this.statusMessage || STATUS_CODES[this.statusCode] || '';
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
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (!this.headersSent) this._flushHead();
    if (chunk && chunk.length) {
      this.socket.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk);
    }
    if (typeof cb === 'function') process.nextTick(cb);
    return true;
  };

  ServerResponse.prototype.end = function (chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
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
    if (body && body.length) this.socket.write(body);
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

    function fail(code) {
      var reason = STATUS_CODES[code] || 'Error';
      socket.write(Buffer.from('HTTP/1.1 ' + code + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', 'latin1'));
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

      // Head complete.
      parsingHead = false;
      req = new IncomingMessage(socket, r);
      var res = new ServerResponse(socket);

      var cl = parseInt(req.headers['content-length'], 10);
      bodyRemaining = cl > 0 ? cl : 0;

      var bodyStart = pending.slice(r.consumed);
      pending = null;

      server.emit('request', req, res);
      feedBody(bodyStart); // deliver any body bytes already buffered; emits 'end' when done
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
    this._net.on('listening', function () { self.emit('listening'); });
    this._net.on('close', function () { self.emit('close'); });
    this._net.on('error', function (e) { self.emit('error', e); });
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
})
