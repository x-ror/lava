/**
 * node:http — minimal HTTP/1.1 server (M2).
 *
 * Built on node:net with request heads parsed by the native picohttpparser bridge
 * (`native.parseRequest`). Supports keep-alive, chunked request/response bodies,
 * and slowloris/idle timeouts. No client API yet.
 *
 * @param {Function} require
 * @param {{ exports: object }} module
 * @param {object} exports
 * @param {{ parseRequest: Function, latin1WriteInto?: Function }} native
 */
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.parseRequest !== 'function') {
    throw new Error('node:http is unavailable on this platform');
  }

  var EventEmitter = require('events');
  var Buffer = require('buffer').Buffer;
  var net = require('net');
  /** Pristine intrinsics — response head must not use overridable Buffer methods. */
  var primordials = require('primordials');
  var nativeLatin1WriteInto =
    typeof native.latin1WriteInto === 'function' ? native.latin1WriteInto : null;

  /** @const {number} Max request-head size before 431. */
  var MAX_HEAD_BYTES = 64 * 1024;

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

  /**
   * Fold `[name, value, ...]` pairs into a null-prototype headers object.
   * Names are lowercased; duplicates join with `', '` (Node for most headers).
   *
   * @param {Array} parseResult flat parseRequest array
   * @param {number} headerStart index of first name/value pair
   * @returns {Object<string, string>}
   */
  function buildHeaders(parseResult, headerStart) {
    var headers = Object.create(null);
    for (var i = headerStart; i + 1 < parseResult.length; i += 2) {
      var lowerName = parseResult[i].toLowerCase();
      var value = parseResult[i + 1];
      if (headers[lowerName] === undefined) headers[lowerName] = value;
      else headers[lowerName] += ', ' + value;
    }
    return headers;
  }

  /**
   * RFC 7230 tchar bitmap for field-names (setHeader + chunked trailers).
   * @type {Uint8Array}
   */
  var HTTP_TCHAR = new Uint8Array(128);
  (function initHttpTchar() {
    var chars = "!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~";
    for (var i = 0; i < chars.length; i++) HTTP_TCHAR[chars.charCodeAt(i)] = 1;
  })();

  /**
   * @param {string} value
   * @returns {boolean}
   */
  function isHttpToken(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code >= 128 || !HTTP_TCHAR[code]) return false;
    }
    return true;
  }

  /**
   * @param {*} name
   * @throws {TypeError} ERR_INVALID_HTTP_TOKEN
   */
  function assertHeaderName(name) {
    if (!isHttpToken(name)) {
      var err = new TypeError(
        'Header name must be a valid HTTP token [' + JSON.stringify(name) + ']',
      );
      err.code = 'ERR_INVALID_HTTP_TOKEN';
      throw err;
    }
  }

  /**
   * Reject CTL (except HT) and code points above 0xFF (latin1 serialization would mask).
   *
   * @param {string} value
   * @param {string} what label for the error message
   * @throws {TypeError} ERR_INVALID_CHAR
   */
  function assertValidHeaderChar(value, what) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code === 9 || (code >= 0x20 && code <= 0x7e) || (code >= 0x80 && code <= 0xff)) {
        continue;
      }
      var err = new TypeError('Invalid character in ' + what);
      err.code = 'ERR_INVALID_CHAR';
      throw err;
    }
  }

  /**
   * @param {number} statusCode
   * @returns {boolean}
   */
  function statusHasNoBody(statusCode) {
    return statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200);
  }

  /**
   * @param {*} statusCode
   * @returns {number}
   * @throws {RangeError} ERR_HTTP_INVALID_STATUS_CODE
   */
  function validateStatusCode(statusCode) {
    var code = Number(statusCode);
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      var err = new RangeError('Invalid status code: ' + JSON.stringify(statusCode));
      err.code = 'ERR_HTTP_INVALID_STATUS_CODE';
      throw err;
    }
    return code;
  }

  var CRLF = Buffer.from('\r\n', 'latin1');
  var LAST_CHUNK = Buffer.from('0\r\n\r\n', 'latin1');
  /** Max combined head+body size for single-write coalesce. */
  var HEAD_BODY_COALESCE_MAX = 64 * 1024;

  /**
   * Write `text` as latin1 into `destination` at `offset`.
   *
   * @param {Uint8Array} destination
   * @param {string} text
   * @param {number} offset
   */
  function writeLatin1Into(destination, text, offset) {
    if (nativeLatin1WriteInto !== null) {
      nativeLatin1WriteInto(destination, text, offset, text.length);
      return;
    }
    for (var i = 0; i < text.length; i++) {
      destination[offset + i] = primordials.StringPrototypeCharCodeAt(text, i) & 0xff;
    }
  }

  /**
   * @param {string} headText latin1 head string
   * @returns {Uint8Array}
   */
  function encodeHeadBytes(headText) {
    var bytes = new primordials.Uint8Array(headText.length);
    writeLatin1Into(bytes, headText, 0);
    return bytes;
  }

  /**
   * @param {Buffer|Uint8Array} bodyChunk
   * @returns {Buffer}
   */
  function frameChunkedBody(bodyChunk) {
    return Buffer.concat([
      Buffer.from(bodyChunk.length.toString(16) + '\r\n', 'latin1'),
      bodyChunk,
      CRLF,
    ]);
  }

  /** @const {number} Max chunk-size / trailer line length. */
  var MAX_CHUNK_LINE_BYTES = 64 * 1024;

  /**
   * Incremental Transfer-Encoding: chunked request-body decoder.
   *
   * @param {IncomingMessage} request
   * @param {function(): void} onError
   * @param {function(Buffer): void} onComplete leftover bytes after the body
   * @returns {function(Buffer|undefined): void} feed
   */
  function createChunkedDecoder(request, onError, onComplete) {
    var buffer = Buffer.alloc(0);
    var state = 'size';
    var bytesRemaining = 0;
    var finished = false;

    function fail() {
      finished = true;
      onError();
    }

    return function feed(incoming) {
      if (finished) return;
      if (incoming && incoming.length) {
        buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;
      }
      for (;;) {
        if (state === 'size') {
          var lineEnd = buffer.indexOf('\r\n');
          if (lineEnd < 0) {
            if (buffer.length > MAX_CHUNK_LINE_BYTES) fail();
            return;
          }
          if (lineEnd > MAX_CHUNK_LINE_BYTES) return fail();
          var sizeLine = buffer.toString('latin1', 0, lineEnd);
          var extensionSep = sizeLine.indexOf(';');
          var sizeToken = extensionSep >= 0 ? sizeLine.slice(0, extensionSep) : sizeLine;
          if (!/^[0-9a-fA-F]+$/.test(sizeToken)) return fail();
          if (extensionSep >= 0 && !/^;[^\s;]/.test(sizeLine.slice(extensionSep))) return fail();
          var chunkSize = parseInt(sizeToken, 16);
          if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) return fail();
          buffer = buffer.slice(lineEnd + 2);
          if (chunkSize === 0) state = 'trailer';
          else {
            bytesRemaining = chunkSize;
            state = 'data';
          }
        } else if (state === 'data') {
          if (buffer.length === 0) return;
          var take = buffer.length < bytesRemaining ? buffer.length : bytesRemaining;
          request.emit('data', buffer.slice(0, take));
          buffer = buffer.slice(take);
          bytesRemaining -= take;
          if (bytesRemaining === 0) state = 'dataCRLF';
        } else if (state === 'dataCRLF') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 13 || buffer[1] !== 10) return fail();
          buffer = buffer.slice(2);
          state = 'size';
        } else {
          if (buffer.length < 2) return;
          if (buffer[0] === 13 && buffer[1] === 10) {
            buffer = buffer.slice(2);
            finished = true;
            return onComplete(buffer);
          }
          var trailerEnd = buffer.indexOf('\r\n');
          if (trailerEnd < 0) {
            if (buffer.length > MAX_CHUNK_LINE_BYTES) fail();
            return;
          }
          if (trailerEnd > MAX_CHUNK_LINE_BYTES) return fail();
          var trailerLine = buffer.toString('latin1', 0, trailerEnd);
          var colon = trailerLine.indexOf(':');
          if (colon <= 0 || !isHttpToken(trailerLine.slice(0, colon))) return fail();
          buffer = buffer.slice(trailerEnd + 2);
        }
      }
    };
  }

  // Flat parseRequest layout (mirrors http.odin PARSE_* / vals[]):
  // [state, consumed, method, url, minor, name, value, ...]
  var PARSE_STATE = 0;
  var PARSE_CONSUMED = 1;
  var PARSE_METHOD = 2;
  var PARSE_URL = 3;
  var PARSE_MINOR = 4;
  var PARSE_HEADERS = 5;
  var PARSE_OK = 0;
  var PARSE_NEED_MORE = 1;

  /**
   * @param {net.Socket} socket
   * @param {Array} parseResult
   * @constructor
   */
  function IncomingMessage(socket, parseResult) {
    EventEmitter.call(this);
    this.socket = socket;
    this.method = parseResult[PARSE_METHOD];
    this.url = parseResult[PARSE_URL];
    this.httpVersionMajor = 1;
    this.httpVersionMinor = parseResult[PARSE_MINOR];
    this.httpVersion = '1.' + parseResult[PARSE_MINOR];
    this.rawHeaders = parseResult.slice(PARSE_HEADERS);
    this.headers = buildHeaders(parseResult, PARSE_HEADERS);
    this.complete = false;
    this._ended = false;
  }
  IncomingMessage.prototype = Object.create(EventEmitter.prototype);
  IncomingMessage.prototype.constructor = IncomingMessage;

  var STATUS_LINE_200 = 'HTTP/1.1 200 OK\r\n';
  var CONNECTION_KEEP_ALIVE = 'Connection: keep-alive\r\n';
  var CONNECTION_CLOSE = 'Connection: close\r\n';

  /**
   * @param {net.Socket} socket
   * @param {string} method
   * @param {number|undefined} httpMinor
   * @constructor
   */
  function ServerResponse(socket, method, httpMinor) {
    EventEmitter.call(this);
    this.socket = socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.headersSent = false;
    this._chunked = false;
    this.finished = false;
    /** @type {Object<string, {name: string, value: string}>} lowercased name → entry */
    this._headers = Object.create(null);
    this._isHead = method === 'HEAD';
    this._allowChunked = httpMinor === undefined || httpMinor >= 1;
    this._keepAlive = false;
    /** @type {function(): void|null} connection hook after finish */
    this._onComplete = null;
  }
  ServerResponse.prototype = Object.create(EventEmitter.prototype);
  ServerResponse.prototype.constructor = ServerResponse;

  /**
   * @param {string} name
   * @param {*} value
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.setHeader = function (name, value) {
    assertHeaderName(name);
    var text = String(value);
    assertValidHeaderChar(text, 'header content [' + name + ']');
    this._headers[name.toLowerCase()] = { name: name, value: text };
    return this;
  };

  /**
   * @param {string} name
   * @returns {string|undefined}
   */
  ServerResponse.prototype.getHeader = function (name) {
    var entry = this._headers[String(name).toLowerCase()];
    return entry ? entry.value : undefined;
  };

  /**
   * @param {string} name
   */
  ServerResponse.prototype.removeHeader = function (name) {
    delete this._headers[String(name).toLowerCase()];
  };

  /**
   * @param {string} name
   * @returns {boolean}
   */
  ServerResponse.prototype.hasHeader = function (name) {
    return this._headers[String(name).toLowerCase()] !== undefined;
  };

  /**
   * @param {number} statusCode
   * @param {string|object} [statusMessage]
   * @param {object} [headers]
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.writeHead = function (statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = validateStatusCode(statusCode);
    if (statusMessage) this.statusMessage = statusMessage;
    if (headers) {
      for (var name in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, name)) {
          this.setHeader(name, headers[name]);
        }
      }
    }
    return this;
  };

  /**
   * Serialize status line + headers; finalizes `_keepAlive`. Does not write or set headersSent.
   *
   * @returns {string} latin1 head text
   */
  ServerResponse.prototype._buildHead = function () {
    var statusCode = validateStatusCode(this.statusCode);
    var reason = this.statusMessage || STATUS_CODES[statusCode] || '';
    assertValidHeaderChar(String(reason), 'statusMessage');
    var head =
      statusCode === 200 && !this.statusMessage
        ? STATUS_LINE_200
        : 'HTTP/1.1 ' + statusCode + ' ' + reason + '\r\n';

    var selfDelimited =
      this._chunked ||
      this.hasHeader('content-length') ||
      this._isHead ||
      statusHasNoBody(this.statusCode);
    if (!selfDelimited) this._keepAlive = false;

    if (this.hasHeader('connection')) {
      if (/\bclose\b/i.test(this.getHeader('connection'))) this._keepAlive = false;
    } else {
      head += this._keepAlive ? CONNECTION_KEEP_ALIVE : CONNECTION_CLOSE;
    }

    for (var lowerName in this._headers) {
      var entry = this._headers[lowerName];
      head += entry.name + ': ' + entry.value + '\r\n';
    }
    head += '\r\n';
    return head;
  };

  ServerResponse.prototype._flushHead = function () {
    if (this.headersSent) return;
    var headBytes = encodeHeadBytes(this._buildHead());
    this.headersSent = true;
    this.socket.write(headBytes);
  };

  /**
   * @param {string|Buffer|Uint8Array} [chunk]
   * @param {string|function} [encoding]
   * @param {function} [callback]
   * @returns {boolean}
   */
  ServerResponse.prototype.write = function (chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    var omitBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      if (
        !omitBody &&
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
    if (!omitBody && chunk && chunk.length) {
      var bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
      this.socket.write(this._chunked ? frameChunkedBody(bytes) : bytes);
    }
    if (typeof callback === 'function') process.nextTick(callback);
    return true;
  };

  /**
   * @param {string|Buffer|Uint8Array|function} [chunk]
   * @param {string|function} [encoding]
   * @param {function} [callback]
   * @returns {ServerResponse}
   */
  ServerResponse.prototype.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (this.finished) return this;

    var body = null;
    if (chunk !== undefined && chunk !== null) {
      body = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : chunk;
    }
    var omitBody = this._isHead || statusHasNoBody(this.statusCode);
    if (!this.headersSent) {
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && !omitBody) {
        this.setHeader('Content-Length', String(body ? body.length : 0));
      }
      if (this._allowChunked && this.hasHeader('transfer-encoding')) {
        this._chunked = /\bchunked\b/i.test(this.getHeader('transfer-encoding'));
      }

      var headText = this._buildHead();
      var totalBytes = headText.length + (body ? body.length : 0);
      if (
        !omitBody &&
        body &&
        body.length &&
        body instanceof primordials.Uint8Array &&
        !this._chunked &&
        totalBytes <= HEAD_BODY_COALESCE_MAX
      ) {
        var combined = new primordials.Uint8Array(totalBytes);
        writeLatin1Into(combined, headText, 0);
        primordials.Uint8ArrayPrototypeSet(combined, body, headText.length);
        this.headersSent = true;
        this.socket.write(combined);
        body = null;
      } else {
        this.headersSent = true;
        this.socket.write(encodeHeadBytes(headText));
      }
    }
    if (!omitBody && body && body.length) {
      this.socket.write(this._chunked ? frameChunkedBody(body) : body);
    }
    if (this._chunked && !omitBody) this.socket.write(LAST_CHUNK);
    this.finished = true;
    if (typeof callback === 'function') process.nextTick(callback);
    this.emit('finish');
    if (this._onComplete) this._onComplete();
    else this.socket.end();
    return this;
  };

  /**
   * @param {number} httpMinor
   * @param {string|undefined} connectionHeader
   * @returns {boolean}
   */
  function shouldKeepAlive(httpMinor, connectionHeader) {
    var connection = (connectionHeader || '').toLowerCase();
    if (httpMinor >= 1) return !/\bclose\b/.test(connection);
    return /\bkeep-alive\b/.test(connection);
  }

  var EMPTY_BUFFER = Buffer.alloc(0);
  var DEADLINE_SWEEP_MS = 100;

  /**
   * @param {Server} server
   * @param {object} deadlines
   */
  function registerConnectionDeadlines(server, deadlines) {
    var sweep = server._connSweep || (server._connSweep = { connections: new Set(), timer: null });
    sweep.connections.add(deadlines);
    if (sweep.timer === null) {
      sweep.timer = setInterval(function () {
        tickConnectionDeadlines(sweep);
      }, DEADLINE_SWEEP_MS);
    }
  }

  /**
   * @param {Server} server
   * @param {object} deadlines
   */
  function unregisterConnectionDeadlines(server, deadlines) {
    var sweep = server._connSweep;
    if (!sweep) return;
    sweep.connections.delete(deadlines);
    if (sweep.connections.size === 0 && sweep.timer !== null) {
      clearInterval(sweep.timer);
      sweep.timer = null;
    }
  }

  /**
   * @param {{ connections: Set, timer: * }} sweep
   */
  function tickConnectionDeadlines(sweep) {
    var now = Date.now();
    sweep.connections.forEach(function (deadlines) {
      if (deadlines.idleUntil !== 0 && now >= deadlines.idleUntil) {
        deadlines.idleUntil = 0;
        deadlines.onIdleTimeout();
      } else if (deadlines.headersUntil !== 0 && now >= deadlines.headersUntil) {
        deadlines.headersUntil = 0;
        deadlines.onRequestTimeout();
      } else if (deadlines.requestUntil !== 0 && now >= deadlines.requestUntil) {
        deadlines.requestUntil = 0;
        deadlines.onRequestTimeout();
      }
    });
  }

  /**
   * Per-connection request/response loop.
   *
   * @param {Server} server
   * @param {net.Socket} socket
   */
  function onConnection(server, socket) {
    var pendingBytes = EMPTY_BUFFER;
    var partialHeadLength = 0;
    var parsingHead = true;
    var request = null;
    var response = null;
    var contentLengthRemaining = 0;
    var chunkedDecoder = null;
    var requestBodyComplete = false;
    var responseComplete = false;
    var peerHalfClosed = false;
    var connectionClosed = false;

    var keepAliveTimeoutMs = server.keepAliveTimeout || 0;
    var headersTimeoutMs = server.headersTimeout || 0;
    var requestTimeoutMs = server.requestTimeout || 0;
    var deadlines = {
      idleUntil: 0,
      headersUntil: 0,
      requestUntil: 0,
      onIdleTimeout: destroyConnection,
      onRequestTimeout: onReceiveTimeout,
    };
    var receivingRequest = false;
    registerConnectionDeadlines(server, deadlines);

    function clearReceiveDeadlines() {
      deadlines.headersUntil = 0;
      deadlines.requestUntil = 0;
    }

    function clearAllDeadlines() {
      deadlines.idleUntil = 0;
      clearReceiveDeadlines();
      unregisterConnectionDeadlines(server, deadlines);
    }

    function destroyConnection() {
      if (connectionClosed) return;
      connectionClosed = true;
      clearAllDeadlines();
      socket.destroy();
    }

    function armIdleDeadline() {
      if (keepAliveTimeoutMs > 0) deadlines.idleUntil = Date.now() + keepAliveTimeoutMs;
    }

    function beginReceiveDeadlines() {
      receivingRequest = true;
      if (headersTimeoutMs > 0 || requestTimeoutMs > 0) {
        var now = Date.now();
        if (headersTimeoutMs > 0) deadlines.headersUntil = now + headersTimeoutMs;
        if (requestTimeoutMs > 0) deadlines.requestUntil = now + requestTimeoutMs;
      }
    }

    function onReceiveTimeout() {
      if (connectionClosed) return;
      if (response && response.headersSent) destroyConnection();
      else sendErrorAndClose(408);
    }

    /**
     * @param {number} statusCode
     */
    function sendErrorAndClose(statusCode) {
      if (connectionClosed) return;
      connectionClosed = true;
      clearAllDeadlines();
      var reason = STATUS_CODES[statusCode] || 'Error';
      socket.write(
        Buffer.from(
          'HTTP/1.1 ' +
            statusCode +
            ' ' +
            reason +
            '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          'latin1',
        ),
      );
      socket.end();
    }

    function resetForNextRequest() {
      parsingHead = true;
      partialHeadLength = 0;
      request = null;
      response = null;
      contentLengthRemaining = 0;
      chunkedDecoder = null;
      requestBodyComplete = false;
      responseComplete = false;
      receivingRequest = false;
    }

    /**
     * Advance when both request body and response are done (keep-alive or close).
     */
    function maybeAdvance() {
      if (connectionClosed || !requestBodyComplete || !responseComplete) return;
      if (!response._keepAlive) {
        connectionClosed = true;
        clearAllDeadlines();
        socket.end();
        return;
      }
      resetForNextRequest();
      if (pendingBytes.length > 0) {
        beginReceiveDeadlines();
        processRequestHead();
      } else if (peerHalfClosed) {
        destroyConnection();
      } else {
        armIdleDeadline();
      }
    }

    function onResponseComplete() {
      responseComplete = true;
      maybeAdvance();
    }

    /**
     * Mark the request fully received (timers off, pipelined leftover stashed).
     * Does not emit `'end'`.
     *
     * @param {Buffer|Uint8Array|undefined} leftover
     */
    function markRequestReceived(leftover) {
      pendingBytes = leftover && leftover.length ? leftover : EMPTY_BUFFER;
      clearReceiveDeadlines();
      requestBodyComplete = true;
    }

    /**
     * Emit request `'end'` once. Accepts a captured request when outer `request`
     * was cleared by a synchronous keep-alive advance.
     *
     * @param {IncomingMessage|null} [targetRequest]
     */
    function emitRequestEnd(targetRequest) {
      var message = targetRequest || request;
      if (message && !message._ended) {
        message._ended = true;
        message.complete = true;
        message.emit('end');
      }
    }

    /**
     * Full body completion: mark received (if needed), emit end, try advance.
     *
     * @param {Buffer|Uint8Array|undefined} leftover
     */
    function onRequestBodyComplete(leftover) {
      if (!requestBodyComplete) markRequestReceived(leftover);
      emitRequestEnd(request);
      maybeAdvance();
    }

    /**
     * @param {Buffer|Uint8Array|undefined} chunk
     */
    function feedContentLengthBody(chunk) {
      if (!request || request._ended) return;
      if (contentLengthRemaining > 0 && chunk && chunk.length) {
        var take = chunk.length < contentLengthRemaining ? chunk.length : contentLengthRemaining;
        request.emit('data', chunk.slice(0, take));
        contentLengthRemaining -= take;
        chunk = chunk.slice(take);
      }
      if (contentLengthRemaining <= 0) onRequestBodyComplete(chunk);
    }

    function processRequestHead() {
      var parseResult = native.parseRequest(pendingBytes, partialHeadLength);
      var state = parseResult[PARSE_STATE];
      if (state === PARSE_NEED_MORE) {
        if (pendingBytes.length > MAX_HEAD_BYTES) sendErrorAndClose(431);
        else partialHeadLength = pendingBytes.length;
        return;
      }
      if (state !== PARSE_OK) return sendErrorAndClose(400);

      var consumed = parseResult[PARSE_CONSUMED];
      if (consumed > MAX_HEAD_BYTES) return sendErrorAndClose(431);

      parsingHead = false;
      partialHeadLength = 0;
      deadlines.headersUntil = 0;

      request = new IncomingMessage(socket, parseResult);
      response = new ServerResponse(socket, request.method, request.httpVersionMinor);
      response._keepAlive = shouldKeepAlive(
        request.httpVersionMinor,
        request.headers['connection'],
      );
      response._onComplete = onResponseComplete;

      var bodyFromHead =
        consumed < pendingBytes.length ? pendingBytes.slice(consumed) : EMPTY_BUFFER;
      pendingBytes = EMPTY_BUFFER;

      var transferEncoding = request.headers['transfer-encoding'];
      var contentLengthHeader = request.headers['content-length'];
      if (transferEncoding !== undefined) {
        if (contentLengthHeader !== undefined) return sendErrorAndClose(400);
        if (!/^\s*chunked\s*$/i.test(transferEncoding)) return sendErrorAndClose(501);
        chunkedDecoder = createChunkedDecoder(
          request,
          function () {
            if (response.headersSent) destroyConnection();
            else sendErrorAndClose(400);
          },
          onRequestBodyComplete,
        );
      } else if (contentLengthHeader !== undefined) {
        if (!/^\d+$/.test(contentLengthHeader)) return sendErrorAndClose(400);
        contentLengthRemaining = parseInt(contentLengthHeader, 10);
      }

      var capturedRequest = request;
      var hasEntityBody = chunkedDecoder !== null || contentLengthRemaining > 0;

      // Bodyless: mark receive-complete before 'request' so sync res.end() can reuse
      // the connection same turn. requestTimeout is receive-only (Node parity).
      // 'end' still fires on nextTick so deferred listeners observe it.
      if (!hasEntityBody) {
        markRequestReceived(bodyFromHead.length ? bodyFromHead : EMPTY_BUFFER);
      }

      server.emit('request', request, response);
      process.nextTick(function () {
        if (connectionClosed) return;
        if (!hasEntityBody) {
          emitRequestEnd(capturedRequest);
          maybeAdvance();
        } else if (chunkedDecoder) {
          chunkedDecoder(bodyFromHead);
        } else {
          feedContentLengthBody(bodyFromHead);
        }
      });
    }

    socket.on('data', function (chunk) {
      if (connectionClosed) return;
      deadlines.idleUntil = 0;
      if (!receivingRequest) beginReceiveDeadlines();
      if (parsingHead) {
        pendingBytes = pendingBytes.length ? Buffer.concat([pendingBytes, chunk]) : chunk;
        processRequestHead();
      } else if (requestBodyComplete) {
        pendingBytes = pendingBytes.length ? Buffer.concat([pendingBytes, chunk]) : chunk;
      } else if (chunkedDecoder) {
        chunkedDecoder(chunk);
      } else {
        feedContentLengthBody(chunk);
      }
    });

    socket.on('end', function () {
      peerHalfClosed = true;
      process.nextTick(function () {
        if (connectionClosed) return;
        if (parsingHead) {
          if (pendingBytes.length > 0) sendErrorAndClose(400);
          else destroyConnection();
        } else if (request && !request._ended) {
          if (response && response.headersSent) destroyConnection();
          else sendErrorAndClose(400);
        }
      });
    });

    socket.on('error', function () {
      connectionClosed = true;
      clearAllDeadlines();
    });

    armIdleDeadline();
  }

  /**
   * @param {object|function} [options]
   * @param {function} [requestListener]
   * @constructor
   */
  function Server(options, requestListener) {
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    EventEmitter.call(this);
    var self = this;
    this.keepAliveTimeout = 5000;
    this.headersTimeout = 60000;
    this.requestTimeout = 300000;
    var tlsContext;
    if (options && typeof options === 'object') {
      if (typeof options.keepAliveTimeout === 'number') {
        this.keepAliveTimeout = options.keepAliveTimeout;
      }
      if (typeof options.headersTimeout === 'number') {
        this.headersTimeout = options.headersTimeout;
      }
      if (typeof options.requestTimeout === 'number') {
        this.requestTimeout = options.requestTimeout;
      }
      tlsContext = options.tls;
    }
    this._net = net.createServer({ tls: tlsContext }, function (socket) {
      onConnection(self, socket);
    });
    this._net.on('listening', function () {
      self.emit('listening');
    });
    this._net.on('close', function () {
      self.emit('close');
    });
    this._net.on('error', function (err) {
      self.emit('error', err);
    });
    if (typeof requestListener === 'function') this.on('request', requestListener);
  }
  Server.prototype = Object.create(EventEmitter.prototype);
  Server.prototype.constructor = Server;

  Server.prototype.listen = function () {
    this._net.listen.apply(this._net, arguments);
    return this;
  };
  Server.prototype.close = function (callback) {
    this._net.close(callback);
    return this;
  };
  Server.prototype.address = function () {
    return this._net.address();
  };

  /**
   * @param {object|function} [options]
   * @param {function} [requestListener]
   * @returns {Server}
   */
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
