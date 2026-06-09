// node:assert (strict semantics) — real assertions that throw AssertionError,
// replacing the previous no-op stubs. Uses util.inspect for readable messages.
(function (require, module) {
  'use strict';

  var inspect = require('util').inspect;

  function AssertionError(options) {
    var message = options.message;
    if (!message) {
      message = inspect(options.actual) + ' ' + options.operator + ' ' + inspect(options.expected);
    }
    var err = new Error(message);
    err.name = 'AssertionError';
    err.code = 'ERR_ASSERTION';
    err.actual = options.actual;
    err.expected = options.expected;
    err.operator = options.operator;
    if (Error.captureStackTrace) Error.captureStackTrace(err, options.stackStartFn || assert);
    return err;
  }

  function fail(actual, expected, message, operator, stackStartFn) {
    if (arguments.length === 1) {
      throw AssertionError({ message: actual, operator: 'fail', stackStartFn: fail });
    }
    throw AssertionError({
      actual: actual,
      expected: expected,
      message: message,
      operator: operator || 'fail',
      stackStartFn: stackStartFn || fail,
    });
  }

  function innerOk(fn, value, message) {
    if (!value) {
      if (message instanceof Error) throw message;
      throw AssertionError({
        actual: value,
        expected: true,
        message: message,
        operator: '==',
        stackStartFn: fn,
      });
    }
  }

  function assert(value, message) {
    innerOk(assert, value, message);
  }
  var ok = assert;

  function isDeepStrictEqual(a, b, seen) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

    var ta = Object.prototype.toString.call(a);
    var tb = Object.prototype.toString.call(b);
    if (ta !== tb) return false;

    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;

    seen = seen || [];
    for (var s = 0; s < seen.length; s++) {
      if (seen[s][0] === a && seen[s][1] === b) return true;
    }
    seen = seen.concat([[a, b]]);

    // TypedArray / Buffer
    if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
      if (a.length !== b.length) return false;
      for (var n = 0; n < a.length; n++) if (a[n] !== b[n]) return false;
      return true;
    }

    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      var mapOk = true;
      a.forEach(function (val, key) {
        if (!b.has(key) || !isDeepStrictEqual(val, b.get(key), seen)) mapOk = false;
      });
      return mapOk;
    }
    if (a instanceof Set) {
      if (a.size !== b.size) return false;
      var setOk = true;
      a.forEach(function (val) {
        if (!b.has(val)) setOk = false;
      });
      return setOk;
    }

    var keysA = Object.keys(a);
    var keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (var i = 0; i < keysA.length; i++) {
      var key = keysA[i];
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!isDeepStrictEqual(a[key], b[key], seen)) return false;
    }
    return true;
  }

  function equal(actual, expected, message) {
    if (!Object.is(actual, expected) && actual !== expected) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'strictEqual',
        stackStartFn: equal,
      });
    }
  }

  function notEqual(actual, expected, message) {
    if (actual === expected) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'notStrictEqual',
        stackStartFn: notEqual,
      });
    }
  }

  function deepEqual(actual, expected, message) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'deepStrictEqual',
        stackStartFn: deepEqual,
      });
    }
  }

  function notDeepEqual(actual, expected, message) {
    if (isDeepStrictEqual(actual, expected)) {
      throw AssertionError({
        actual: actual,
        expected: expected,
        message: message,
        operator: 'notDeepStrictEqual',
        stackStartFn: notDeepEqual,
      });
    }
  }

  function match(value, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp');
    }
    if (!regexp.test(value)) {
      throw AssertionError({
        actual: value,
        expected: regexp,
        message: message,
        operator: 'match',
        stackStartFn: match,
      });
    }
  }

  function doesNotMatch(value, regexp, message) {
    if (!(regexp instanceof RegExp)) {
      throw new TypeError('The "regexp" argument must be an instance of RegExp');
    }
    if (regexp.test(value)) {
      throw AssertionError({
        actual: value,
        expected: regexp,
        message: message,
        operator: 'doesNotMatch',
        stackStartFn: doesNotMatch,
      });
    }
  }

  // classExtendsError reports whether `fn` is an Error constructor (Error itself
  // or a subclass), so `throws(fn, TypeError)` does an instanceof check.
  function classExtendsError(fn) {
    if (typeof fn !== 'function') return false;
    if (fn === Error) return true;
    return fn.prototype != null && fn.prototype instanceof Error;
  }

  // expectedMatches checks a thrown/rejected value against the Node matcher
  // forms: RegExp (vs the message), an Error constructor (instanceof), a
  // validation function (truthy return), or a plain object (each property must
  // deep-equal, with RegExp values tested against the stringified property).
  function expectedMatches(actual, expected) {
    if (expected instanceof RegExp) {
      return expected.test(
        String(actual && actual.message !== undefined ? actual.message : actual),
      );
    }
    if (classExtendsError(expected)) {
      return actual instanceof expected;
    }
    if (typeof expected === 'function') {
      return !!expected(actual);
    }
    if (expected && typeof expected === 'object') {
      var keys = Object.keys(expected);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var exp = expected[key];
        var act = actual == null ? undefined : actual[key];
        if (exp instanceof RegExp) {
          if (!exp.test(String(act))) return false;
        } else if (!isDeepStrictEqual(act, exp)) {
          return false;
        }
      }
      return true;
    }
    return true; // no/unknown expectation: only "did it throw" matters
  }

  function throws(fn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    var threw = false;
    var actual;
    try {
      fn();
    } catch (e) {
      threw = true;
      actual = e;
    }
    if (!threw) {
      throw AssertionError({
        message: message || 'Missing expected exception.',
        operator: 'throws',
        stackStartFn: throws,
      });
    }
    if (expected !== undefined && expected !== null && !expectedMatches(actual, expected)) {
      throw actual;
    }
  }

  function doesNotThrow(fn, message) {
    try {
      fn();
    } catch (e) {
      throw AssertionError({
        message: (message ? message + ': ' : '') + 'Got unwanted exception.',
        operator: 'doesNotThrow',
        stackStartFn: doesNotThrow,
      });
    }
  }

  function settle(promiseOrFn) {
    if (typeof promiseOrFn === 'function') return Promise.resolve().then(promiseOrFn);
    return Promise.resolve(promiseOrFn);
  }

  function rejects(promiseOrFn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    return settle(promiseOrFn).then(
      function () {
        throw AssertionError({
          message: message || 'Missing expected rejection.',
          operator: 'rejects',
          stackStartFn: rejects,
        });
      },
      function (actual) {
        if (expected !== undefined && expected !== null && !expectedMatches(actual, expected)) {
          throw actual;
        }
      },
    );
  }

  function doesNotReject(promiseOrFn, expected, message) {
    if (typeof expected === 'string') {
      message = expected;
      expected = undefined;
    }
    return settle(promiseOrFn).then(undefined, function (actual) {
      throw AssertionError({
        message: (message ? message + ': ' : '') + 'Got unwanted rejection.\n' + inspect(actual),
        operator: 'doesNotReject',
        stackStartFn: doesNotReject,
      });
    });
  }

  function ifError(value) {
    if (value !== null && value !== undefined) {
      throw AssertionError({
        actual: value,
        expected: null,
        message: 'ifError got unwanted exception: ' + inspect(value),
        operator: 'ifError',
        stackStartFn: ifError,
      });
    }
  }

  assert.ok = ok;
  assert.fail = fail;
  assert.AssertionError = AssertionError;
  assert.equal = equal;
  assert.strictEqual = equal;
  assert.notEqual = notEqual;
  assert.notStrictEqual = notEqual;
  assert.deepEqual = deepEqual;
  assert.deepStrictEqual = deepEqual;
  assert.notDeepEqual = notDeepEqual;
  assert.notDeepStrictEqual = notDeepEqual;
  assert.match = match;
  assert.doesNotMatch = doesNotMatch;
  assert.throws = throws;
  assert.doesNotThrow = doesNotThrow;
  assert.rejects = rejects;
  assert.doesNotReject = doesNotReject;
  assert.ifError = ifError;
  assert.strict = assert;

  module.exports = assert;
});
