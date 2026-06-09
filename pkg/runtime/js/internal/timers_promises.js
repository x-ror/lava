// node:timers/promises — promise-based timers backed by the global timer
// functions (setTimeout/setImmediate) and the event loop. All accept an
// AbortSignal via options.signal. Like Node, an abort always rejects with an
// AbortError ("The operation was aborted") and carries the signal's reason as
// the error's `cause` (so e.g. AbortSignal.timeout surfaces as cause.name
// === "TimeoutError").
(function (require, module, exports) {
  'use strict';

  function abortError(signal) {
    var err = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    if (signal && signal.reason !== undefined) err.cause = signal.reason;
    return err;
  }

  function setTimeoutPromise(delay, value, options) {
    options = options || {};
    var signal = options.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      var onAbort = null;
      var timer = setTimeout(function () {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      }, delay);
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = function () {
          clearTimeout(timer);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  function setImmediatePromise(value, options) {
    options = options || {};
    var signal = options.signal;
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      var onAbort = null;
      var timer = setImmediate(function () {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve(value);
      });
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = function () {
          clearImmediate(timer);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  async function* setIntervalAsync(delay, value, options) {
    options = options || {};
    var signal = options.signal;
    if (signal && signal.aborted) throw abortError(signal);
    while (true) {
      await setTimeoutPromise(delay, undefined, { signal: signal });
      yield value;
    }
  }

  var scheduler = {
    wait: function (delay, options) {
      return setTimeoutPromise(delay, undefined, options);
    },
    yield: function () {
      return setImmediatePromise(undefined);
    },
  };

  module.exports = {
    setTimeout: setTimeoutPromise,
    setImmediate: setImmediatePromise,
    setInterval: setIntervalAsync,
    scheduler: scheduler,
  };
});
