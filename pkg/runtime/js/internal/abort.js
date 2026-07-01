// AbortController / AbortSignal (WHATWG DOM standard, also used across Node).
// Installed as globals like Buffer. AbortSignal is a minimal EventTarget that
// only carries the "abort" event, which is all the platform uses it for.
(function (require, module, _exports) {
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
    if (typeof signal._onabort === 'function') {
      try {
        signal._onabort.call(signal, event);
      } catch (e) {
        reportOrIgnore(e);
      }
    }
    var listeners = signal._listeners.slice();
    for (var i = 0; i < listeners.length; i++) {
      if (listeners[i].once) {
        var at = signal._listeners.indexOf(listeners[i]);
        if (at !== -1) signal._listeners.splice(at, 1);
      }
      try {
        listeners[i].fn.call(signal, event);
      } catch (e) {
        reportOrIgnore(e);
      }
    }
  }

  // Node calls reportError() for listener throws; surface via console.error as a
  // best-effort equivalent (keeps throw from silently swallowing or propagating).
  function reportOrIgnore(e) {
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('Unhandled error in abort listener:', e);
    }
  }

  function runAbort(signal, reason) {
    if (signal._aborted) return;
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    fireAbort(signal);
    // An aborted signal can never fire again: drop every listener so their
    // closures (and anything they capture) become collectable immediately.
    signal._listeners.length = 0;
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
  function findListener(list, listener) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].fn === listener) return i;
    }
    return -1;
  }
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type !== ABORT || typeof listener !== 'function') return;
    if (findListener(this._listeners, listener) === -1) {
      this._listeners.push({ fn: listener, once: !!(options && options.once) });
    }
  };
  AbortSignal.prototype.removeEventListener = function (type, listener) {
    if (type !== ABORT) return;
    var index = findListener(this._listeners, listener);
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
    if (!signals || typeof signals[Symbol.iterator] !== 'function') {
      throw new TypeError('AbortSignal.any requires an iterable');
    }
    var combined = newSignal();
    var list = Array.from(signals);
    for (var i = 0; i < list.length; i++) {
      if (list[i]._aborted) {
        runAbort(combined, list[i]._reason);
        return combined;
      }
    }
    // Keep per-source listeners so we can unsubscribe them all once the combined
    // signal fires — prevents a leak on long-lived parent signals.
    var handlers = [];
    function onSourceAbort(source) {
      return function () {
        // Remove all handlers from all sources before triggering the combined abort.
        for (var j = 0; j < list.length; j++) {
          list[j].removeEventListener(ABORT, handlers[j]);
        }
        runAbort(combined, source._reason);
      };
    }
    for (var k = 0; k < list.length; k++) {
      var handler = onSourceAbort(list[k]);
      handlers.push(handler);
      list[k].addEventListener(ABORT, handler);
    }
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

  if (globalThis.AbortController === undefined) globalThis.AbortController = AbortController;
  if (globalThis.AbortSignal === undefined) globalThis.AbortSignal = AbortSignal;

  module.exports = { AbortController: AbortController, AbortSignal: AbortSignal };
});
