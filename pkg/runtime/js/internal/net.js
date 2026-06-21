// node:net — minimal TCP server + socket (M1), modeled on Node's net.Server /
// net.Socket. Backed by the native reactor primitives in pkg/runtime/net.odin
// (make_net_bindings): a connection is addressed by an integer id; the native side
// pushes data/end/close/error into the per-connection handlers this module registers
// via native.startConnection once the Socket exists. Client sockets (net.connect),
// IPC/Unix sockets, and true half-close are out of scope for M1.
(function (require, module, exports, native) {
  'use strict';

  if (!native || typeof native.listen !== 'function') {
    throw new Error('node:net is unavailable on this platform');
  }

  var EventEmitter = require('events');
  var { Buffer } = require('buffer');

  // Wrap native bytes (a Uint8Array) as a Buffer view over the same memory (no copy),
  // so 'data' yields a Buffer like Node.
  function asBuffer(u8) {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  function toBytes(data, encoding) {
    if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
    return data; // Buffer / Uint8Array — native reads it directly
  }

  function Socket(id) {
    EventEmitter.call(this);
    this._id = id;
    this.destroyed = false;
    this.writableEnded = false;
    this.readableEnded = false;
  }
  Socket.prototype = Object.create(EventEmitter.prototype);
  Socket.prototype.constructor = Socket;

  Socket.prototype.write = function (data, encoding, cb) {
    if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (this.destroyed) {
      if (typeof cb === 'function') process.nextTick(cb, new Error('socket has been destroyed'));
      return false;
    }
    var ok = native.write(this._id, toBytes(data, encoding));
    if (typeof cb === 'function') process.nextTick(cb);
    return ok;
  };

  Socket.prototype.end = function (data, encoding, cb) {
    if (typeof data === 'function') {
      cb = data;
      data = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (this.destroyed) return this;
    if (data !== undefined && data !== null) native.write(this._id, toBytes(data, encoding));
    this.writableEnded = true;
    native.end(this._id);
    if (typeof cb === 'function') this.once('close', cb);
    return this;
  };

  Socket.prototype.destroy = function () {
    if (this.destroyed) return this;
    native.close(this._id);
    return this;
  };

  // Called by the native onClose handler: mark destroyed and emit 'close' once.
  Socket.prototype._onClose = function (hadError) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close', !!hadError);
  };

  function Server(options, connectionListener) {
    if (typeof options === 'function') {
      connectionListener = options;
      options = {};
    }
    EventEmitter.call(this);
    this._id = 0;
    this._listening = false;
    this._port = 0;
    this._host = '0.0.0.0';
    if (typeof connectionListener === 'function') this.on('connection', connectionListener);
  }
  Server.prototype = Object.create(EventEmitter.prototype);
  Server.prototype.constructor = Server;

  // Native invokes this with the accepted connection's id. Register the native handlers
  // FIRST, then emit 'connection'. JS is single-threaded and this whole function runs
  // synchronously inside the native accept callback, so no 'data' can fire until the loop
  // ticks again (after we return) — there is no "data before the user's handler" window.
  // Arming first means on_close/on_end ARE registered if a 'connection' handler closes the
  // socket synchronously (socket.destroy()/end()), so its 'close'/'end' still fire.
  Server.prototype._onConnection = function (id) {
    var socket = new Socket(id);
    native.startConnection(
      id,
      function (u8) {
        socket.emit('data', asBuffer(u8));
      },
      function () {
        socket.readableEnded = true;
        socket.emit('end');
      },
      function (hadError) {
        socket._onClose(hadError);
      },
      function (msg) {
        socket.emit('error', new Error(String(msg)));
      },
    );
    this.emit('connection', socket);
  };

  Server.prototype.listen = function (port, host, backlog, cb) {
    // listen(port[, host][, backlog][, cb]) — collapse the optional middle args.
    var args = [host, backlog, cb];
    var rest = [];
    for (var i = 0; i < args.length; i++) if (args[i] !== undefined) rest.push(args[i]);
    host = '0.0.0.0';
    backlog = 511;
    cb = undefined;
    for (var j = 0; j < rest.length; j++) {
      var a = rest[j];
      if (typeof a === 'function') cb = a;
      else if (typeof a === 'string') host = a;
      else if (typeof a === 'number') backlog = a;
    }
    var self = this;
    if (typeof cb === 'function') this.once('listening', cb);
    try {
      this._id = native.listen(port >>> 0, host, backlog, function (id) {
        self._onConnection(id);
      });
    } catch (e) {
      process.nextTick(function () {
        self.emit('error', e);
      });
      return this;
    }
    this._listening = true;
    this._port = port >>> 0;
    this._host = host;
    process.nextTick(function () {
      self.emit('listening');
    });
    return this;
  };

  Server.prototype.address = function () {
    if (!this._listening) return null;
    var port = native.serverPort(this._id);
    return { port: port, address: this._host, family: 'IPv4' };
  };

  Server.prototype.close = function (cb) {
    var self = this;
    if (this._listening) {
      native.closeServer(this._id);
      this._listening = false;
      if (typeof cb === 'function') this.once('close', cb);
      process.nextTick(function () {
        self.emit('close');
      });
    } else if (typeof cb === 'function') {
      process.nextTick(cb, new Error('Server is not running'));
    }
    return this;
  };

  function createServer(options, connectionListener) {
    return new Server(options, connectionListener);
  }

  module.exports = { createServer: createServer, Server: Server, Socket: Socket };
});
