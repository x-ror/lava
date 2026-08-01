// process.stdout / process.stderr.
//
// Built on the real `stream.Writable` rather than a lookalike object, because node's
// streams are Writables in every fd case and libraries feature-detect with
// `x instanceof stream.Writable` (measured on node 24.18.1: true for the tty, pipe and
// file shapes alike). A hand-rolled object with a `write` method would answer false and
// silently take the wrong branch in a logger.
//
// NODE'S SHAPE, measured rather than read off the docs — `process.stdout` is polymorphic:
//
//   stdout ->   constructor        write(300KB)   isTTY       columns
//   file        SyncWriteStream    true           undefined   undefined
//   pipe        Socket             false          undefined   undefined
//   tty         WriteStream        true           true        <number>
//
// The `undefined`s matter and are not `false`/`80`: `if (stream.isTTY)` and
// `stream.columns || 80` are the two idioms in the wild, and reporting `false`/`80` off a
// terminal makes the second one silently disagree with node. tty.js's WriteStream gets
// this wrong today (it reports isTTY false and columns 80 on a pipe); this module does
// not inherit that.
//
// SCOPE: only `isTTY` is implemented. `columns` and `rows` are absent from the prototype,
// so they read `undefined` on a terminal too — correct off one, WRONG on one, where node
// reports numbers. Supplying them needs a TIOCGWINSZ ioctl that does not exist in the
// tree yet (`linux.ioctl` and `linux.TIOCGWINSZ` are both in core:sys/linux; only the
// `winsize` struct needs declaring). Deliberately not faked to 80x24 — that is exactly
// the tty.js bug named above. Tracked in ROADMAP beside the getWindowSize entry.
(function (require, module, exports, native) {
  'use strict';

  var P = require('primordials');
  var ObjectDefineProperty = P.ObjectDefineProperty;
  var ObjectSetPrototypeOf = P.ObjectSetPrototypeOf;
  var TypeErrorG = P.TypeError;
  var ReflectApply = P.ReflectApply;
  var Uint8ArrayG = P.Uint8Array;
  var ArrayBufferIsView = P.ArrayBufferIsView;

  var Writable = require('stream').Writable;
  var BufferG = require('buffer').Buffer;

  var writeSync = native && typeof native.writeSync === 'function' ? native.writeSync : null;
  var isattyNative = native && typeof native.isatty === 'function' ? native.isatty : null;

  function isatty(fd) {
    if (isattyNative === null) return false;
    try {
      return !!isattyNative(fd);
    } catch {
      return false;
    }
  }

  /**
   * A synchronous Writable over fd 1 or 2.
   * @param {number} fd
   * @node Mirrors process.stdout/stderr's observable surface for the non-tty case; the
   *       tty extras (columns/rows/getWindowSize) appear only when isatty(fd).
   * @deviates `write()` always returns true. node queues PIPE writes and answers false
   *       under backpressure, but nothing is buffered here — the byte is on the fd before
   *       write() returns — so there is no drain to wait for and true is the honest
   *       answer. Matches node exactly for the file and tty cases, which are 2 of its 3.
   *       Pinned by tests/node-compat/cases/60-process-stdio.js.
   */
  function StdioWriteStream(fd) {
    ReflectApply(Writable, this, [{ decodeStrings: false, autoDestroy: false, emitClose: false }]);
    this.fd = fd;
    // `_isTTY` rather than a stored `isTTY`: the public one is a getter below so that a
    // non-terminal answers undefined instead of false, which is what node reports.
    this._isTTY = isatty(fd);
  }

  ObjectSetPrototypeOf(StdioWriteStream.prototype, Writable.prototype);
  ObjectSetPrototypeOf(StdioWriteStream, Writable);

  StdioWriteStream.prototype._write = function (chunk, encoding, callback) {
    try {
      // The Writable is constructed with decodeStrings:false, so a string arrives as a
      // string and its encoding has to be applied here rather than assumed utf8.
      var payload = typeof chunk === 'string' ? BufferG.from(chunk, encoding || 'utf8') : chunk;
      if (writeSync === null) {
        throw new TypeErrorG('process.stdout is unavailable: the stdio native is missing');
      }
      writeSync(this.fd, payload);
    } catch (err) {
      callback(err);
      return;
    }
    // Synchronous completion. The callback is still invoked through the stream machinery,
    // which defers it — node does not run a write callback inline either (verified).
    callback();
  };

  // `isTTY`, `columns` and `rows` are undefined off a terminal, matching node. Defined as
  // getters so the answer cannot be stale if a future SIGWINCH handler lands, and so the
  // absent case is a genuine `undefined` rather than a property holding undefined.
  ObjectDefineProperty(StdioWriteStream.prototype, 'isTTY', {
    configurable: true,
    get: function () {
      return this._isTTY ? true : undefined;
    },
  });

  // Node validates the chunk BEFORE queueing, and reports two distinct errors: null gets
  // ERR_STREAM_NULL_VALUES (checked first), anything not a string/Buffer/view gets
  // ERR_INVALID_ARG_TYPE. Lava's Writable does neither today — `write(5)` is accepted and
  // `write(null)` throws asynchronously with no code — so the check lives here rather
  // than in stream.js, which is a wider surface than this change should move.
  StdioWriteStream.prototype.write = function (chunk, encoding, callback) {
    if (chunk === null) {
      var nullErr = new TypeErrorG('May not write null values to stream');
      nullErr.code = 'ERR_STREAM_NULL_VALUES';
      throw nullErr;
    }
    if (typeof chunk !== 'string' && !isBytes(chunk)) {
      var typeErr = new TypeErrorG(
        'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array. ' +
          'Received ' +
          inspectType(chunk),
      );
      typeErr.code = 'ERR_INVALID_ARG_TYPE';
      throw typeErr;
    }
    return ReflectApply(Writable.prototype.write, this, [chunk, encoding, callback]);
  };

  function isBytes(v) {
    return v instanceof Uint8ArrayG || ArrayBufferIsView(v);
  }

  function inspectType(v) {
    if (v === undefined) return 'undefined';
    if (typeof v === 'number' || typeof v === 'boolean') return 'type ' + typeof v + ' (' + v + ')';
    return 'type ' + typeof v;
  }

  function makeStream(fd) {
    return new StdioWriteStream(fd);
  }

  // Attach as LAZY, configurable getters, which is what node does — building both
  // streams eagerly would cost an isatty() per startup for a process that may never
  // print. Configurable so a test harness can replace them, as node allows.
  //
  // Done here rather than natively because JSObjectSetProperty cannot express a getter;
  // the loader eager-requires this module, so the properties exist before user code runs.
  function install(proc) {
    if (!proc || typeof proc !== 'object') return;
    var cached = { __proto__: null, 1: null, 2: null };
    var define = function (name, fd) {
      ObjectDefineProperty(proc, name, {
        configurable: true,
        enumerable: true,
        get: function () {
          if (cached[fd] === null) cached[fd] = makeStream(fd);
          return cached[fd];
        },
        set: function (v) {
          // node allows assignment (harnesses swap stdout); keep that, and keep the
          // property configurable rather than turning it into a data property.
          cached[fd] = v;
        },
      });
    };
    define('stdout', 1);
    define('stderr', 2);
  }

  module.exports = { makeStream: makeStream, isatty: isatty, install: install };
});
