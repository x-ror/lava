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
// Hardening: the few intrinsics the scheduler relies on (Promise.resolve,
// Promise.prototype.then, Array.prototype.slice, Function.prototype.apply) are
// captured here at install time — before any user code runs — so user code that
// later reassigns e.g. Promise.resolve cannot silently break scheduling. (The
// runtime otherwise avoids primordials; the scheduler is special because every
// async API depends on it.)
//
// KNOWN LIMITATION: a nextTick registered *after* a promise/microtask within the
// same turn does not preempt that already-queued promise job (Node's absolute
// nextTick priority). Matching that would require suppressing JSC's automatic
// microtask drain (JSC::VM::DrainMicrotaskDelayScope), a C++-ABI symbol absent
// from Apple's JavaScriptCore.framework, so it would break the macOS build.
// Tracked as a follow-up; see tests/runtime/eventloop/cases/10-* and the
// known-lava-gaps entry.
(function (globalThis, process, reportUncaught) {
	"use strict";

	// Intrinsics captured at install time (see "Hardening" above).
	var PromiseCtor = Promise;
	var promiseResolve = Promise.resolve;
	var promiseThen = Promise.prototype.then;
	var arraySlice = Array.prototype.slice;
	var functionApply = Function.prototype.apply;
	var resolved = promiseResolve.call(PromiseCtor);
	var EMPTY = [];

	// schedule(fn) enqueues fn as a JSC microtask, in FIFO with promise jobs, via
	// a reaction on a pre-resolved promise. fn must not throw (callers guard).
	function schedule(fn) {
		promiseThen.call(resolved, fn);
	}

	// runGuarded calls fn(...args) and turns any throw into an uncaught exception
	// report rather than letting it reject the scheduling promise.
	function runGuarded(fn, args) {
		try {
			functionApply.call(fn, undefined, args);
		} catch (error) {
			reportUncaught(error);
		}
	}

	var queue = []; // pending nextTick tasks: { fn, args }
	var armed = false; // a drain microtask is scheduled but has not yet run
	var draining = false; // currently inside drain()

	function drain() {
		armed = false;
		if (draining) return; // re-entrancy guard (shouldn't happen, but be safe)
		draining = true;
		try {
			// shift() one at a time so nextTicks queued *during* the drain (including
			// nested ones) are flushed in this same pass, ahead of any promise job. A
			// throwing callback is reported but does not abort the remaining queue.
			while (queue.length > 0) {
				var task = queue.shift();
				runGuarded(task.fn, task.args);
			}
		} finally {
			draining = false;
		}
	}

	function nextTick(callback) {
		if (typeof callback !== "function") {
			throw new TypeError('The "callback" argument must be of type function. Received ' + typeof callback);
		}
		var args = arguments.length > 1 ? arraySlice.call(arguments, 1) : EMPTY;
		queue.push({ fn: callback, args: args });
		// Arm a single drain reaction for the batch. Already-armed or mid-drain: the
		// existing drain/while-loop will pick this task up.
		if (!armed && !draining) {
			armed = true;
			schedule(drain);
		}
	}

	function queueMicrotask(callback) {
		if (typeof callback !== "function") {
			throw new TypeError('The "callback" argument must be of type function. Received ' + typeof callback);
		}
		// Share JSC's single microtask queue with promise jobs, in FIFO order; a
		// throw surfaces as an uncaught exception (Node), not an unhandled rejection.
		schedule(function () {
			runGuarded(callback, EMPTY);
		});
	}

	process.nextTick = nextTick;
	globalThis.queueMicrotask = queueMicrotask;
})
