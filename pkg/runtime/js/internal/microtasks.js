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
// KNOWN LIMITATION: a nextTick registered *after* a promise/microtask within the
// same turn does not preempt that already-queued promise job (Node's absolute
// nextTick priority). Matching that would require suppressing JSC's automatic
// microtask drain (JSC::VM::DrainMicrotaskDelayScope), which is a C++-ABI symbol
// absent from Apple's JavaScriptCore.framework and would break the macOS build.
// Tracked as a follow-up.
(function (globalThis, process) {
	"use strict";

	var queue = []; // pending nextTick tasks: { fn, args }
	var armed = false; // a drain microtask is scheduled but has not yet run
	var draining = false; // currently inside drain()

	function drain() {
		armed = false;
		if (draining) return; // re-entrancy guard (shouldn't happen, but be safe)
		draining = true;
		try {
			// shift() one at a time so nextTicks queued *during* the drain (including
			// nested ones) are flushed in this same pass, ahead of any promise job.
			while (queue.length > 0) {
				var task = queue.shift();
				task.fn.apply(undefined, task.args);
			}
		} finally {
			draining = false;
		}
	}

	function nextTick(callback) {
		if (typeof callback !== "function") {
			throw new TypeError('The "callback" argument must be of type function. Received ' + typeof callback);
		}
		var args = arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : [];
		queue.push({ fn: callback, args: args });
		// Arm a single drain reaction for the batch. Already-armed or mid-drain: the
		// existing drain/while-loop will pick this task up.
		if (!armed && !draining) {
			armed = true;
			Promise.resolve().then(drain);
		}
	}

	function queueMicrotask(callback) {
		if (typeof callback !== "function") {
			throw new TypeError('The "callback" argument must be of type function. Received ' + typeof callback);
		}
		// Route through a resolved-promise reaction so the callback shares JSC's
		// single microtask queue with Promise jobs, in FIFO registration order.
		Promise.resolve().then(function () {
			callback();
		});
	}

	process.nextTick = nextTick;
	globalThis.queueMicrotask = queueMicrotask;
})
