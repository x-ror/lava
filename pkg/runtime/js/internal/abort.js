// AbortController / AbortSignal (WHATWG DOM standard, also used across Node).
// Installed as globals like Buffer. AbortSignal is a minimal EventTarget that
// only carries the "abort" event, which is all the platform uses it for.
(function (require, module, exports) {
  'use strict';

  var ABORT = 'abort';

  function abortError() {
    var err = new Error('This operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    return err;
  }

  function timeoutError() {
    var err = new Error('The operation timed out');
    err.name = 'TimeoutError';
    err.code = 'ABORT_ERR';
    return err;
  }

  function AbortSignal() {
    throw new TypeError('Illegal constructor');
  }

  // Internal constructor: AbortSignal is not directly constructable, so
  // controllers and the static factories mint instances through here.
  function newSignal() {
    var signal = Object.create(AbortSignal.prototype);
    signal._aborted = false;
    signal._reason = undefined;
    signal._listeners = [];
    signal._onabort = null;
    return signal;
  }

  function fireAbort(signal) {
    var event = { type: ABORT, target: signal, currentTarget: signal };
    if (typeof signal._onabort === 'function') signal._onabort.call(signal, event);
    var listeners = signal._listeners.slice();
    for (var i = 0; i < listeners.length; i++) listeners[i].call(signal, event);
  }

  function runAbort(signal, reason) {
    if (signal._aborted) return;
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    fireAbort(signal);
  }

  Object.defineProperty(AbortSignal.prototype, 'aborted', {
    get: function () {
      return this._aborted;
    },
    configurable: true,
  });
  Object.defineProperty(AbortSignal.prototype, 'reason', {
    get: function () {
      return this._reason;
    },
    configurable: true,
  });
  Object.defineProperty(AbortSignal.prototype, 'onabort', {
    get: function () {
      return this._onabort;
    },
    set: function (fn) {
      this._onabort = typeof fn === 'function' ? fn : null;
    },
    configurable: true,
  });
  AbortSignal.prototype.throwIfAborted = function () {
    if (this._aborted) throw this._reason;
  };
  AbortSignal.prototype.addEventListener = function (type, listener) {
    if (type !== ABORT || typeof listener !== 'function') return;
    if (this._listeners.indexOf(listener) === -1) this._listeners.push(listener);
  };
  AbortSignal.prototype.removeEventListener = function (type, listener) {
    if (type !== ABORT) return;
    var index = this._listeners.indexOf(listener);
    if (index !== -1) this._listeners.splice(index, 1);
  };
  AbortSignal.prototype.dispatchEvent = function (event) {
    if (event && event.type === ABORT) fireAbort(this);
    return true;
  };

  AbortSignal.abort = function (reason) {
    var signal = newSignal();
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    return signal;
  };

  AbortSignal.timeout = function (delay) {
    var signal = newSignal();
    var timer = setTimeout(function () {
      runAbort(signal, timeoutError());
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return signal;
  };

  AbortSignal.any = function (signals) {
    var combined = newSignal();
    var list = Array.from(signals);
    for (var i = 0; i < list.length; i++) {
      if (list[i]._aborted) {
        runAbort(combined, list[i]._reason);
        return combined;
      }
    }
    list.forEach(function (source) {
      source.addEventListener(ABORT, function () {
        runAbort(combined, source._reason);
      });
    });
    return combined;
  };

  function AbortController() {
    if (!(this instanceof AbortController))
      throw new TypeError("Constructor AbortController requires 'new'");
    Object.defineProperty(this, 'signal', { value: newSignal(), enumerable: true });
  }
  AbortController.prototype.abort = function (reason) {
    runAbort(this.signal, reason);
  };

  if (typeof globalThis.AbortController === 'undefined')
    globalThis.AbortController = AbortController;
  if (typeof globalThis.AbortSignal === 'undefined') globalThis.AbortSignal = AbortSignal;

  module.exports = { AbortController: AbortController, AbortSignal: AbortSignal };
});
