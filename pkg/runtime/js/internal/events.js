// node:events — EventEmitter plus the static once(emitter, name) helper.
// Pure JS; the common synchronous + Promise-based surface real code relies on.
(function (require, module) {
  'use strict';

  // Pristine intrinsics (see primordials.js) so a script that mutates
  // Array.prototype/Object/etc. cannot alter EventEmitter's internal bookkeeping.
  var P = require('primordials');
  var defaultMaxListeners = 10;

  function EventEmitter() {
    EventEmitter.init.call(this);
  }

  EventEmitter.init = function () {
    if (this._events === undefined || this._events === P.ObjectGetPrototypeOf(this)._events) {
      this._events = P.ObjectCreate(null);
      this._eventsCount = 0;
    }
    this._maxListeners = this._maxListeners || undefined;
  };

  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._maxListeners = undefined;

  EventEmitter.prototype.setMaxListeners = function (n) {
    this._maxListeners = n;
    return this;
  };

  EventEmitter.prototype.getMaxListeners = function () {
    return this._maxListeners === undefined ? defaultMaxListeners : this._maxListeners;
  };

  function addListener(target, type, listener, prepend) {
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function');
    }
    if (target._events === undefined) EventEmitter.init.call(target);
    var events = target._events;
    var existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      target._eventsCount++;
    } else if (typeof existing === 'function') {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      P.ArrayPrototypeUnshift(existing, listener);
    } else {
      P.ArrayPrototypePush(existing, listener);
    }
    return target;
  }

  EventEmitter.prototype.addListener = function (type, listener) {
    return addListener(this, type, listener, false);
  };
  EventEmitter.prototype.on = EventEmitter.prototype.addListener;

  EventEmitter.prototype.prependListener = function (type, listener) {
    return addListener(this, type, listener, true);
  };

  function onceWrap(target, type, listener) {
    var fired = false;
    function wrapped() {
      if (fired) return;
      fired = true;
      target.removeListener(type, wrapped);
      return P.FunctionPrototypeApply(listener, target, arguments);
    }
    wrapped.listener = listener;
    return wrapped;
  }

  EventEmitter.prototype.once = function (type, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('The "listener" argument must be of type function');
    }
    return addListener(this, type, onceWrap(this, type, listener), false);
  };

  EventEmitter.prototype.prependOnceListener = function (type, listener) {
    return addListener(this, type, onceWrap(this, type, listener), true);
  };

  EventEmitter.prototype.removeListener = function (type, listener) {
    if (this._events === undefined) return this;
    var list = this._events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = P.ObjectCreate(null);
      else delete this._events[type];
    } else if (typeof list !== 'function') {
      var position = -1;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          position = i;
          break;
        }
      }
      if (position < 0) return this;
      P.ArrayPrototypeSplice(list, position, 1);
      if (list.length === 1) this._events[type] = list[0];
    }
    return this;
  };
  EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

  EventEmitter.prototype.removeAllListeners = function (type) {
    if (this._events === undefined) return this;
    if (arguments.length === 0) {
      this._events = P.ObjectCreate(null);
      this._eventsCount = 0;
    } else if (this._events[type] !== undefined) {
      if (--this._eventsCount === 0) this._events = P.ObjectCreate(null);
      else delete this._events[type];
    }
    return this;
  };

  EventEmitter.prototype.emit = function (type) {
    var events = this._events;
    var handler = events === undefined ? undefined : events[type];
    if (handler === undefined) {
      if (type === 'error') {
        var err = arguments[1];
        if (err instanceof Error) throw err;
        var e = new Error('Unhandled error.' + (err !== undefined ? ' (' + err + ')' : ''));
        e.context = err;
        throw e;
      }
      return false;
    }
    var args = P.ArrayPrototypeSlice(arguments, 1);
    if (typeof handler === 'function') {
      P.FunctionPrototypeApply(handler, this, args);
    } else {
      var listeners = P.ArrayPrototypeSlice(handler);
      for (var i = 0; i < listeners.length; i++) {
        P.FunctionPrototypeApply(listeners[i], this, args);
      }
    }
    return true;
  };

  EventEmitter.prototype.listeners = function (type) {
    var events = this._events;
    if (events === undefined) return [];
    var handler = events[type];
    if (handler === undefined) return [];
    if (typeof handler === 'function') return [handler.listener || handler];
    return P.ArrayPrototypeMap(handler, function (h) {
      return h.listener || h;
    });
  };

  EventEmitter.prototype.rawListeners = function (type) {
    var events = this._events;
    if (events === undefined) return [];
    var handler = events[type];
    if (handler === undefined) return [];
    return typeof handler === 'function' ? [handler] : P.ArrayPrototypeSlice(handler);
  };

  EventEmitter.prototype.listenerCount = function (type) {
    var events = this._events;
    if (events === undefined) return 0;
    var handler = events[type];
    if (handler === undefined) return 0;
    return typeof handler === 'function' ? 1 : handler.length;
  };

  EventEmitter.prototype.eventNames = function () {
    return this._eventsCount > 0 ? P.ReflectOwnKeys(this._events) : [];
  };

  // once(emitter, name) — resolves with the emitted arguments on the next
  // matching event, or rejects if 'error' fires first.
  function once(emitter, name) {
    return new P.Promise(function (resolve, reject) {
      function eventListener() {
        if (errorListener !== undefined) emitter.removeListener('error', errorListener);
        resolve(P.ArrayPrototypeSlice(arguments));
      }
      var errorListener;
      if (name !== 'error') {
        errorListener = function (err) {
          emitter.removeListener(name, eventListener);
          reject(err);
        };
        emitter.once('error', errorListener);
      }
      emitter.once(name, eventListener);
    });
  }

  EventEmitter.EventEmitter = EventEmitter;
  EventEmitter.once = once;
  EventEmitter.defaultMaxListeners = defaultMaxListeners;

  module.exports = EventEmitter;
  module.exports.EventEmitter = EventEmitter;
  module.exports.once = once;
});
