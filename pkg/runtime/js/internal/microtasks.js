// process.nextTick and queueMicrotask, ordered to match Node on JavaScriptCore.
//
// JSC drains its own promise-job (microtask) queue automatically at every C-API
// boundary — the end of JSEvaluateScript and the end of each timer/I/O callback
// invocation — and the JSC C API exposes no portable hook to drain an embedder
// queue ahead of it. So rather than fight that queue, we live inside it: both
// process.nextTick and queueMicrotask schedule a JSC microtask (a resolved-
// promise reaction), which keeps them in one FIFO with user promise jobs. That
// already matches Node for queueMicrotask, where queueMicrotask callbacks and
// Promise jobs share the single microtask queue.
//
// process.nextTick keeps Node's higher priority by funnelling a whole batch of
// nextTick callbacks through ONE drain microtask, armed when the batch's first
// nextTick is queued. Because that drain reaction is enqueued at the moment the
// first nextTick of the turn is registered, it runs ahead of any promise job
// registered later in the same turn, and it empties the entire nextTick queue
// (including nextTicks queued *during* the drain, and nested ones) before it
// returns — matching Node's "the nextTick queue drains fully before the
// microtask queue resumes" (see tests/runtime/eventloop SEM cases).
//
// Errors: a throw from a nextTick/queueMicrotask callback is an *uncaught
// exception* in Node (it reaches uncaughtException), NOT an unhandled rejection.
// We therefore run every callback guarded and route a throw to reportUncaught —
// the same native reporter the timer path uses (report_uncaught +
// mark_async_failed) — so the category matches and one throwing callback does
// not abort the rest of the drain via promise-rejection mechanics. (Like the
// timer path, Lava reports and keeps draining rather than halting the process
// the instant a callback throws; the process still exits non-zero.)
//
// Hardening: every intrinsic the scheduler relies on is captured at install
// time — before any user code runs — so reassigning them afterwards cannot
// silently break scheduling. Function.prototype.bind/call are captured to build
// an uncurryThis helper, which then captures Promise.resolve, Promise.prototype
// .then, and Array.prototype.slice as standalone functions invoked via [[Call]]
// (not through the user-mutable .call); Reflect.apply is captured for callback
// invocation; and the nextTick queue is stored/advanced by index rather than via
// Array.prototype.push/shift. (The runtime otherwise avoids primordials; the
// scheduler is special because every async API depends on it.)
//
// KNOWN LIMITATION: a nextTick registered *after* a promise/microtask within the
// same turn does not preempt that already-queued promise job (Node's absolute
// nextTick priority). Matching that would require suppressing JSC's automatic
// microtask drain (JSC::VM::DrainMicrotaskDelayScope), a C++-ABI symbol absent
// from Apple's JavaScriptCore.framework, so it would break the macOS build.
// Tracked as a follow-up; see tests/runtime/eventloop/cases/10-* and the
// known-lava-gaps entry.
(function (globalThis, process, reportUncaught) {
  'use strict';

  var PromiseCtor = Promise;
  var bind = Function.prototype.bind;
  var call = Function.prototype.call;
  var uncurryThis = bind.bind(call);
  var promiseResolve = uncurryThis(Promise.resolve);
  var promiseThen = uncurryThis(Promise.prototype.then);
  var arraySlice = uncurryThis(Array.prototype.slice);
  var functionApply = Reflect.apply;
  var EMPTY = [];
  var resolved = promiseResolve(PromiseCtor);

  function schedule(fn) {
    promiseThen(resolved, fn);
  }

  function runGuarded(fn, args) {
    try {
      functionApply(fn, undefined, args);
    } catch (error) {
      reportUncaught(error);
    }
  }

  var queue = [];
  var head = 0;
  var tail = 0;
  var armed = false;
  var draining = false;

  function drain() {
    armed = false;
    if (draining) return;
    draining = true;
    try {
      while (head < tail) {
        var task = queue[head];
        queue[head] = undefined;
        head = head + 1;
        runGuarded(task.fn, task.args);
      }
      head = 0;
      tail = 0;
      queue.length = 0;
    } finally {
      draining = false;
    }
  }

  function nextTick(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        'The "callback" argument must be of type function. Received ' + typeof callback,
      );
    }
    var args = arguments.length > 1 ? arraySlice(arguments, 1) : EMPTY;
    queue[tail] = { fn: callback, args: args };
    tail = tail + 1;
    if (!armed && !draining) {
      armed = true;
      schedule(drain);
    }
  }

  function queueMicrotask(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(
        'The "callback" argument must be of type function. Received ' + typeof callback,
      );
    }
    schedule(function () {
      runGuarded(callback, EMPTY);
    });
  }

  process.nextTick = nextTick;
  globalThis.queueMicrotask = queueMicrotask;
});
