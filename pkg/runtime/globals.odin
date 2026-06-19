package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:strings"
import "core:time"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Runtime_State holds per-context state. A pointer to it lives in the global
// object's private data slot (see make_global_class) instead of being exposed
// to JavaScript, so user code can neither read nor corrupt the loop pointer.
Runtime_State :: struct {
	loop:              ^eventloop.Loop,
	// Allocator that owns the module_cache key strings. Captured from the caller's
	// context at state creation and used EXPLICITLY when cloning/freeing keys, because
	// keys are cloned inside `proc "c"` require callbacks (where context is reset to
	// runtime.default_context — the heap allocator) but freed later in
	// destroy_runtime_state under the caller's context. Without an explicit allocator
	// those two contexts can differ (e.g. an embedder/test using a custom or tracking
	// allocator), causing a bad free. The map itself carries its own bound allocator.
	allocator:         runtime.Allocator,
	module_cache:      map[string]jsc.JSValueRef, // resolved path / specifier -> module.exports
	builtin_require:   jsc.JSValueRef, // JS resolver for internal modules (events/util/assert/buffer); GC-protected
	esm_transform:     jsc.JSValueRef, // js/internal/esm.js transform(source,url,filename,dirname); GC-protected
	// Standard JS error constructors (Error/TypeError/RangeError/…) snapshotted and
	// GC-protected from globalThis at context init, before any user code runs (see
	// capture_error_intrinsics). make_native_error builds native throws from these
	// instead of re-reading the mutable global, so a script that overwrites e.g.
	// globalThis.RangeError cannot intercept or alter a native error (errors.odin).
	// Keys are static literals; values unprotected on destroy.
	error_intrinsics:  map[string]jsc.JSValueRef,
	// Set when an uncaught exception escapes an async callback or a promise
	// rejects with no handler. The process then exits non-zero even though the
	// initial JSEvaluateScript returned cleanly (see resolve_exit_code).
	async_failed:      bool,
	rejection_handler: jsc.JSValueRef, // GC-protected fn registered with JSC; unprotected on destroy
	// process.nextTick scheduling shim (js/internal/microtasks.js). JSC auto-drains
	// its promise-job queue at every C boundary, so to keep nextTick callbacks
	// ahead of those jobs (Node semantics) native must bracket the boundary itself:
	// dispatch_fn runs an event-loop callback and drains nextTicks before returning,
	// next_tick_drain re-drains after JSC's auto-drain. Both GC-protected; driven by
	// invoke_user_callback.
	dispatch_fn:       jsc.JSValueRef,
	next_tick_drain:   jsc.JSValueRef,
	// Settled fetch requests awaiting free. Their teardown is deferred to here
	// because the io_uring watcher may reference a request once more after it is
	// stopped; freeing only at destroy keeps that memory valid (see fetch.odin).
	pending_free:      [dynamic]^Fetch_Request,
	// Fetches currently owned by this runtime context. Used during abnormal eval
	// teardown to stop requests and join any DNS worker before the loop/context die.
	active_fetches:    [dynamic]^Fetch_Request,
	// In-flight node:dns lookups (see dns.odin). Tracked for the same reason as
	// active_fetches: abnormal teardown must join the resolver workers before the
	// loop/context die, or a worker can post_async into freed memory.
	active_dns:        [dynamic]^Dns_Lookup_Request,
	// node:sqlite handle registries: opaque id -> ^sqlite.Database / ^sqlite.Statement
	// (kept as rawptr so this struct need not import pkg/std/sqlite). See sqlite.odin.
	sqlite_dbs:        map[u64]rawptr,
	sqlite_stmts:      map[u64]rawptr,
	next_sqlite_id:    u64,
	// Node-style process.argv: [execPath, scriptPath, ...userArgs]. Built in eval()
	// and read by install_process. Empty for embedders that don't set it (then
	// install_process falls back to os.args).
	script_argv:       []string,
}

// JS_Callback bridges a JS function into an event-loop Callback. The function
// and any trailing timer arguments are GC-protected for the lifetime of the
// binding so JavaScriptCore cannot collect them between scheduling and firing.
JS_Callback :: struct {
	ctx:       jsc.JSContextRef,
	func:      jsc.JSObjectRef,
	// Trailing arguments forwarded to the callback on every fire
	// (setTimeout/Interval(fn, delay, ...args), setImmediate(fn, ...args)).
	// Owned + GC-protected by this binding; nil when there are none.
	args:      []jsc.JSValueRef,
	repeating: bool,
}

when ODIN_OS == .Darwin {
	PROCESS_PLATFORM :: "darwin"
} else when ODIN_OS == .Linux {
	PROCESS_PLATFORM :: "linux"
} else when ODIN_OS == .Windows {
	PROCESS_PLATFORM :: "win32"
} else {
	PROCESS_PLATFORM :: "unknown"
}

when ODIN_ARCH == .amd64 {
	PROCESS_ARCH :: "x64"
} else when ODIN_ARCH == .arm64 {
	PROCESS_ARCH :: "arm64"
} else when ODIN_ARCH == .i386 {
	PROCESS_ARCH :: "ia32"
} else {
	PROCESS_ARCH :: "unknown"
}

// --- Runtime state lifecycle ---

new_runtime_state :: proc(loop: ^eventloop.Loop) -> ^Runtime_State {
	state := new(Runtime_State)
	state.loop = loop
	// Capture the owning allocator for module_cache keys (see the field comment).
	state.allocator = context.allocator
	state.module_cache = make(map[string]jsc.JSValueRef)
	state.error_intrinsics = make(map[string]jsc.JSValueRef)
	state.active_fetches = make([dynamic]^Fetch_Request)
	state.active_dns = make([dynamic]^Dns_Lookup_Request)
	state.sqlite_dbs = make(map[u64]rawptr)
	state.sqlite_stmts = make(map[u64]rawptr)
	state.next_sqlite_id = 1
	return state
}

destroy_runtime_state :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil do return
	fetch_shutdown_active(state)
	fetch_destroy_pending(state)
	dns_destroy_state(state)
	sqlite_destroy_state(state)
	for key, value in state.module_cache {
		unprotect_before_eval_exit(ctx, value)
		delete(key, state.allocator)
	}
	delete(state.module_cache)
	for _, ctor in state.error_intrinsics {
		unprotect_before_eval_exit(ctx, ctor)
	}
	delete(state.error_intrinsics)
	unprotect_before_eval_exit(ctx, state.builtin_require)
	unprotect_before_eval_exit(ctx, state.esm_transform)
	unprotect_before_eval_exit(ctx, state.rejection_handler)
	unprotect_before_eval_exit(ctx, state.dispatch_fn)
	unprotect_before_eval_exit(ctx, state.next_tick_drain)
	free(state)
}

// unprotect_before_eval_exit drops a GC root held by Runtime_State — except on
// Windows, where it is a no-op (a nil value is also skipped everywhere).
//
// This mirrors release_global_context_after_eval's Windows carve-out and exists
// for the same reason: these unprotects run from eval's deferred teardown right
// before the one-shot CLI's os.exit. On Windows, touching JSC's GC during that
// final teardown races the VM's concurrent GC/JIT worker threads — which a heavy
// JS workload (e.g. node:crypto scrypt's ROMix) leaves running at exit — and
// poisons the ensuing ExitProcess DLL-detach, so the process exits 127
// (ERROR_PROC_NOT_FOUND) despite the script having run correctly. The VM is
// already intentionally leaked on Windows (the context is never released), so
// dropping these roots is a semantic no-op anyway; the OS reclaims everything,
// exactly as the process.exit() fast path already does. Other platforms tear
// down cleanly and keep unprotecting.
unprotect_before_eval_exit :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) {
	if value == nil do return
	when ODIN_OS != .Windows {
		jsc.JSValueUnprotect(ctx, value)
	}
}

get_state_from_ctx :: proc(ctx: jsc.JSContextRef) -> ^Runtime_State {
	global := jsc.JSContextGetGlobalObject(ctx)
	return cast(^Runtime_State)jsc.JSObjectGetPrivate(global)
}

// get_loop_from_ctx returns the event loop bound to this context (or nil).
// Replaces the previous string-based __loop_ptr__ global.
get_loop_from_ctx :: proc(ctx: jsc.JSContextRef) -> ^eventloop.Loop {
	state := get_state_from_ctx(ctx)
	if state == nil do return nil
	return state.loop
}

// make_global_class creates a JSClass whose instances support a private-data
// slot. We use it for the global object so we can stash Runtime_State on it.
make_global_class :: proc() -> jsc.JSClassRef {
	def := jsc.JSClassDefinition {
		class_name = "LavaGlobal",
	}
	return jsc.JSClassCreate(&def)
}

// --- Module cache ---

module_cache_get :: proc(state: ^Runtime_State, key: string) -> (jsc.JSValueRef, bool) {
	if state == nil do return nil, false
	value, ok := state.module_cache[key]
	return value, ok
}

module_cache_put :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	key: string,
	value: jsc.JSValueRef,
) {
	if state == nil do return
	if _, ok := state.module_cache[key]; ok do return
	cloned, err := strings.clone(key, state.allocator)
	if err != nil do return
	jsc.JSValueProtect(ctx, value)
	state.module_cache[cloned] = value
}

// module_cache_set inserts or replaces the cached exports for `key`. The
// CommonJS loader uses it to pre-register an in-progress module before
// evaluating its body (so a re-entrant/circular require returns the partial
// exports) and again afterwards to store the final exports (the body may have
// reassigned module.exports). Replacing re-points GC protection to the new value.
module_cache_set :: proc(
	ctx: jsc.JSContextRef,
	state: ^Runtime_State,
	key: string,
	value: jsc.JSValueRef,
) {
	if state == nil do return
	if existing, ok := state.module_cache[key]; ok {
		if existing == value do return
		jsc.JSValueProtect(ctx, value) // protect new before unprotecting old
		jsc.JSValueUnprotect(ctx, existing)
		state.module_cache[key] = value // reuse the existing (owned) key string
		return
	}
	cloned, err := strings.clone(key, state.allocator)
	if err != nil do return
	jsc.JSValueProtect(ctx, value)
	state.module_cache[cloned] = value
}

// module_cache_remove drops a cached entry, unprotecting its value and freeing
// the owned key string. Used when a module throws while loading so a failed
// module is not left cached as partial exports (matching Node, which re-loads).
module_cache_remove :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State, key: string) {
	if state == nil do return
	value, ok := state.module_cache[key]
	if !ok do return
	jsc.JSValueUnprotect(ctx, value)
	// The stored key is a clone we own; capture it so we can free it after the
	// entry is removed (Odin maps do not free string-key backing memory).
	stored_key: string
	for k in state.module_cache {
		if k == key {
			stored_key = k
			break
		}
	}
	delete_key(&state.module_cache, key)
	if len(stored_key) > 0 do delete(stored_key, state.allocator)
}

// --- JS callback bridge ---

make_js_callback :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	repeating: bool,
	args: []jsc.JSValueRef = nil,
) -> ^JS_Callback {
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
	cb := new(JS_Callback)
	cb.ctx = ctx
	cb.func = fn
	cb.args = args
	cb.repeating = repeating
	return cb
}

// capture_timer_args clones and GC-protects the trailing timer arguments — every
// argument at or after `start` (index 2 for setTimeout/setInterval, 1 for
// setImmediate). The returned slice is owned by the JS_Callback and released by
// free_js_callback. Returns nil when there are none (or on allocation failure).
capture_timer_args :: proc(
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	start: int,
) -> []jsc.JSValueRef {
	n := int(argument_count) - start
	if n <= 0 do return nil
	args, err := make([]jsc.JSValueRef, n)
	if err != nil do return nil
	for i in 0 ..< n {
		v := arguments[start + i]
		jsc.JSValueProtect(ctx, v)
		args[i] = v
	}
	return args
}

// free_js_callback releases a binding. When release_roots is true it also
// unprotects the function and every forwarded argument; when false, only the
// native binding memory is released and the roots stay with the process-lifetime
// VM. Called once per binding - by js_callback_trampoline on a one-shot's only
// fire, or by js_callback_dispose when the loop drops the binding without
// (re-)firing.
free_js_callback :: proc(cb: ^JS_Callback, release_roots := true) {
	if release_roots {
		jsc.JSValueUnprotect(cb.ctx, cast(jsc.JSValueRef)cb.func)
		for arg in cb.args {
			jsc.JSValueUnprotect(cb.ctx, arg)
		}
	}
	delete(cb.args)
	free(cb)
}

// should_release_fired_callback_roots keeps normal callback GC-root cleanup on
// every platform except the Windows one-shot CLI exit edge. A heavy final JS
// callback (crypto.scrypt's setImmediate-backed ROMix is the current canary, but
// the same holds for any timer/immediate/I-O callback) can leave JSC worker
// threads alive; unprotecting the just-fired callback root as the last loop work
// then poisons Windows process teardown and ExitProcess reports 127. If more loop
// work exists, keep releasing roots so long-running scripts do not leak every
// one-shot timer/immediate callback. The VM is already intentionally leaked on
// Windows at eval exit, so the final callback root is reclaimed by the OS with the
// rest of the process.
//
// "Last loop work" is has_pending_work() read from inside the trampoline: run_once
// uncounts the firing task (immediates/I-O/close removed before the call, one-shot
// timers ref-dropped at pop) before invoking it, so the check sees only the work
// queued *behind* this callback — true for any final callback, not just setImmediate.
should_release_fired_callback_roots :: proc(loop: ^eventloop.Loop) -> bool {
	when ODIN_OS == .Windows {
		return eventloop.has_pending_work(loop)
	}
	return true
}

js_callback_trampoline :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	cb := cast(^JS_Callback)user_data
	if cb == nil do return

	exception: jsc.JSValueRef
	invoke_user_callback(cb.ctx, cb.func, raw_data(cb.args), c.size_t(len(cb.args)), &exception)
	if exception != nil {
		report_uncaught(cb.ctx, exception)
		mark_async_failed(cb.ctx)
	}

	// Non-repeating callbacks (setTimeout/setImmediate/microtasks) fire once;
	// release their GC protection and heap binding. Repeating timers keep the
	// binding alive for the next tick — it is released by js_callback_dispose
	// (the loop's dispose hook) when the interval is cleared, since the
	// trampoline never runs for a cancelled timer.
	if !cb.repeating {
		free_js_callback(cb, should_release_fired_callback_roots(loop))
	}
}

// js_callback_dispose is the event loop's dispose hook for timer/immediate
// bindings: it releases a JS_Callback the loop drops without firing (a cleared
// setTimeout/setImmediate) or after firing without re-arming (a setInterval
// cleared from within its own callback). It mirrors the trampoline's one-shot
// cleanup, so a binding is freed exactly once — by the trampoline when it fires
// for the last time, or here when it is cancelled.
js_callback_dispose :: proc(user_data: rawptr) {
	cb := cast(^JS_Callback)user_data
	if cb == nil do return
	free_js_callback(cb)
}

report_uncaught :: proc(ctx: jsc.JSContextRef, exception: jsc.JSValueRef) {
	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	defer if allocated do delete(msg, context.allocator)
	os.write_string(os.stderr, "Uncaught ")
	os.write_string(os.stderr, msg)
	os.write_string(os.stderr, "\n")
}

// mark_async_failed records that the process should exit non-zero because an
// async callback threw or a promise rejected without a handler. resolve_exit_code
// reads it once the loop drains.
mark_async_failed :: proc(ctx: jsc.JSContextRef) {
	if state := get_state_from_ctx(ctx); state != nil {
		state.async_failed = true
	}
}

// unhandled_rejection_cb is registered with JavaScriptCore via
// JSGlobalContextSetUnhandledRejectionCallback. JSC invokes it as
// handler(promise, reason) at a microtask checkpoint when a rejected promise has
// no handler, matching Node's default --unhandled-rejections=throw behavior.
unhandled_rejection_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	reason := jsc.JSValueMakeUndefined(ctx)
	if argument_count >= 2 do reason = arguments[1]
	msg, allocated := jsc_value_to_string_or_default(ctx, reason)
	defer if allocated do delete(msg, context.allocator)
	os.write_string(os.stderr, "Uncaught (in promise) ")
	os.write_string(os.stderr, msg)
	os.write_string(os.stderr, "\n")
	mark_async_failed(ctx)
	return jsc.JSValueMakeUndefined(ctx)
}

// install_rejection_tracker registers unhandled_rejection_cb with the context so
// unhandled promise rejections surface to stderr and the exit code.
install_rejection_tracker :: proc(ctx: jsc.JSContextRef) {
	name := jsc.JSStringCreateWithUTF8CString("unhandledRejection")
	defer jsc.JSStringRelease(name)
	handler := jsc.JSObjectMakeFunctionWithCallback(ctx, name, unhandled_rejection_cb)
	if handler == nil do return
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)handler)
	if state := get_state_from_ctx(ctx); state != nil {
		state.rejection_handler = cast(jsc.JSValueRef)handler
	}
	jsc.JSGlobalContextSetUnhandledRejectionCallback(cast(jsc.JSGlobalContextRef)ctx, handler, nil)
}

// get_named reads object[name], returning nil on allocation failure. Mirror of
// set_named; used to read process.exitCode when resolving the exit code.
get_named :: proc(ctx: jsc.JSContextRef, object: jsc.JSObjectRef, name: string) -> jsc.JSValueRef {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return nil
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectGetProperty(ctx, object, js_name, nil)
}

// callback_arg returns the argument as a callable function object, or nil.
callback_arg :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> jsc.JSObjectRef {
	if !jsc.JSValueIsObject(ctx, value) do return nil
	obj := cast(jsc.JSObjectRef)value
	if !jsc.JSObjectIsFunction(ctx, obj) do return nil
	return obj
}

// make_js_error / make_js_named_error and the Node ERR_* helpers live in
// errors.odin (the single source of truth for native error construction).

// --- Timer / scheduling callbacks ---

// TIMER_MAX_MS is Node's TIMEOUT_MAX (2^31 - 1): the largest setTimeout/setInterval
// delay. A delay outside [1, TIMER_MAX_MS] (including NaN/Infinity) clamps to 1ms.
TIMER_MAX_MS :: 2147483647.0
// MAX_SAFE_HANDLE_ID bounds a numeric timer/immediate id for the u64() conversion in
// clear*: ids grow unbounded but stay exactly representable as f64 below 2^53.
MAX_SAFE_HANDLE_ID :: 9007199254740992.0

// clamp_timer_delay applies Node's [1, 2^31-1] ms clamp to a raw setTimeout/
// setInterval delay and returns the u64 the event loop expects. Anything < 1
// (including NaN) or > TIMER_MAX_MS becomes 1 — which also covers two guards:
// flooring at 1 stops a 0ms timer from busy-spinning the loop and starving pending
// I/O (and freezing the virtual clock), and the bounded value makes the u64()
// conversion safe (float→int on NaN/Infinity/out-of-range is undefined in Odin).
clamp_timer_delay :: proc(delay: f64) -> u64 {
	if !(delay >= 1 && delay <= TIMER_MAX_MS) do return 1
	return u64(delay)
}

set_timeout_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	delay := 0.0
	if argument_count >= 2 do delay = jsc.JSValueToNumber(ctx, arguments[1], nil)

	// Trailing args (setTimeout(fn, delay, ...args)) are forwarded on fire.
	cb := make_js_callback(ctx, fn, false, capture_timer_args(ctx, argument_count, arguments, 2))
	id := eventloop.set_timeout(
		loop,
		js_callback_trampoline,
		clamp_timer_delay(delay),
		cb,
		js_callback_dispose,
	)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

set_interval_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	interval := 0.0
	if argument_count >= 2 do interval = jsc.JSValueToNumber(ctx, arguments[1], nil)

	// Trailing args (setInterval(fn, delay, ...args)) are forwarded on every fire.
	cb := make_js_callback(ctx, fn, true, capture_timer_args(ctx, argument_count, arguments, 2))
	id := eventloop.set_interval(
		loop,
		js_callback_trampoline,
		clamp_timer_delay(interval),
		cb,
		js_callback_dispose,
	)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

set_immediate_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	fn := callback_arg(ctx, arguments[0])
	if fn == nil do return jsc.JSValueMakeUndefined(ctx)

	// Trailing args (setImmediate(fn, ...args)) are forwarded on fire.
	cb := make_js_callback(ctx, fn, false, capture_timer_args(ctx, argument_count, arguments, 1))
	id := eventloop.set_immediate(loop, js_callback_trampoline, cb, js_callback_dispose)
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

clear_timer_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	loop := get_loop_from_ctx(ctx)
	if loop == nil || argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	// clearTimeout/clearInterval(NaN) (and any non-finite/negative id) is a no-op in
	// Node — no handle can carry that id. Guard before u64(): float→int on NaN or an
	// out-of-range value is undefined in Odin and could match an unrelated live id.
	// Handle ids start at 1 and grow unbounded, but stay f64-exact below 2^53, so the
	// upper bound is the exact-integer limit, not the timer-delay clamp.
	n := jsc.JSValueToNumber(ctx, arguments[0], nil)
	if !(n >= 1 && n <= MAX_SAFE_HANDLE_ID) do return jsc.JSValueMakeUndefined(ctx)
	eventloop.clear_timeout(loop, u64(n))
	return jsc.JSValueMakeUndefined(ctx)
}

// process.nextTick and queueMicrotask are installed from JS (MICROTASK_PRELUDE)
// rather than as native callbacks: their Node-matching ordering relative to
// JSC's promise-job queue is expressed most naturally in JS. See
// install_microtasks and js/internal/microtasks.js.

// --- console ---
//
// The full `console` surface (util.format `%s/%d/%j` substitution, group
// indentation, `table`, `time`/`count`, `assert`/`trace`/`dir`, …) is
// implemented in JavaScript — see CONSOLE_PRELUDE / install_console — exactly
// as Node implements lib/internal/console. The native layer only exposes two
// raw write primitives so stdout and stderr stay under Odin's control.

console_raw_write :: proc(
	fd: ^os.File,
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
) {
	if argument_count < 1 do return
	text, allocated := jsc_value_to_string_or_default(ctx, arguments[0])
	os.write_string(fd, text)
	if allocated do delete(text, context.allocator)
}

console_stdout_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_raw_write(os.stdout, ctx, argument_count, arguments)
	return jsc.JSValueMakeUndefined(ctx)
}

console_stderr_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_raw_write(os.stderr, ctx, argument_count, arguments)
	return jsc.JSValueMakeUndefined(ctx)
}

// --- process ---

process_exit_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// process.exit([code]): with no argument (or explicit undefined) the default is
	// process.exitCode (Node parity). An explicit numeric code overrides it; a NaN
	// code is a RangeError (ERR_OUT_OF_RANGE) in Node, not a silent garbage exit.
	code := process_exit_code(ctx)
	// JSValueGetType reads the value's type directly; JSValueIsUndefined is equally
	// ABI-safe now that it returns a 1-byte `bool` (see cmd/lava jsc_value_predicates,
	// #159 — the retired `b32` return was the old hazard).
	if argument_count >= 1 && jsc.JSValueGetType(ctx, arguments[0]) != .Undefined {
		n := jsc.JSValueToNumber(ctx, arguments[0], nil)
		if n != n {
			if exception != nil {
				exception^ = err_out_of_range(ctx, "code", "an integer", "NaN")
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		code = int(n)
	}
	os.exit(code)
}

process_cwd_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	dir, err := os.get_working_directory(context.temp_allocator)
	if err != os.ERROR_NONE do return js_string_value(ctx, ".")
	return js_string_value(ctx, dir)
}

// --- installation ---

// install_globals wires the Node-like global surface (console, process,
// timers, queueMicrotask, globalThis) onto the context's global object.
// Timer functions are no-ops when no event loop is bound.
install_globals :: proc(ctx: jsc.JSContextRef, loop: ^eventloop.Loop) {
	global := jsc.JSContextGetGlobalObject(ctx)

	set_named(ctx, global, "globalThis", cast(jsc.JSValueRef)global)
	set_named(ctx, global, "global", cast(jsc.JSValueRef)global)

	inject_native_function(ctx, global, "setTimeout", set_timeout_cb)
	inject_native_function(ctx, global, "setInterval", set_interval_cb)
	inject_native_function(ctx, global, "setImmediate", set_immediate_cb)
	inject_native_function(ctx, global, "clearTimeout", clear_timer_cb)
	inject_native_function(ctx, global, "clearInterval", clear_timer_cb)
	inject_native_function(ctx, global, "clearImmediate", clear_timer_cb)

	install_console(ctx, global)
	install_internal_modules(ctx, global)

	install_process(ctx, global)
	install_performance(ctx, global)
	// process.nextTick + queueMicrotask are a JS shim (needs `process` to exist).
	install_microtasks(ctx, global)
	install_rejection_tracker(ctx)
}

// The Performance API clock origin. perf_origin_tick anchors the monotonic
// high-resolution timer (performance.now); perf_time_origin_ms is the wall-clock
// Unix epoch at that anchor (performance.timeOrigin), so
// timeOrigin + now() approximates Date.now(). Captured once per process.
@(private = "file")
perf_initialized: bool
@(private = "file")
perf_origin_tick: time.Tick
@(private = "file")
perf_time_origin_ms: f64

// install_performance installs the `performance` global with a monotonic now()
// and a timeOrigin, matching the W3C High Resolution Time surface Node exposes.
install_performance :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	if !perf_initialized {
		perf_origin_tick = time.tick_now()
		perf_time_origin_ms = f64(time.to_unix_nanoseconds(time.now())) / 1e6
		perf_initialized = true
	}

	performance := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, performance, "now", performance_now_cb)
	set_named(ctx, performance, "timeOrigin", jsc.JSValueMakeNumber(ctx, perf_time_origin_ms))
	set_named(ctx, global, "performance", cast(jsc.JSValueRef)performance)
}

// performance_now_cb returns the high-resolution milliseconds (a fractional
// double) elapsed on the monotonic clock since the time origin.
performance_now_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	ms := time.duration_milliseconds(time.tick_since(perf_origin_tick))
	return jsc.JSValueMakeNumber(ctx, ms)
}

// install_microtasks evaluates MICROTASK_PRELUDE to a factory and calls it with
// (globalThis, process) so it can install process.nextTick and queueMicrotask
// with Node-matching ordering. See js/internal/microtasks.js for why these live
// in JS on top of JSC's promise-job queue rather than the native event loop.
install_microtasks :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	process := get_named(ctx, global, "process")
	if process == nil || !jsc.JSValueIsObject(ctx, process) do return

	factory := eval_internal(ctx, "lava:microtasks", MICROTASK_PRELUDE)
	if factory == nil || !jsc.JSValueIsObject(ctx, factory) do return

	// A throw from a nextTick/queueMicrotask callback is an uncaught exception
	// (not an unhandled rejection); the shim routes it here, the same path the
	// timer trampoline uses for async callbacks.
	report := make_native_function(ctx, "__lava_report_uncaught", microtask_report_uncaught_cb)
	if report == nil do return

	args := [3]jsc.JSValueRef{cast(jsc.JSValueRef)global, process, cast(jsc.JSValueRef)report}
	exception: jsc.JSValueRef
	exports := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)factory,
		nil,
		3,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil {
		report_internal_exception(ctx, "lava:microtasks", exception)
		return
	}

	// The factory returns { drainNextTicks, dispatch }. Stash both (GC-protected)
	// on Runtime_State; invoke_user_callback drives them so process.nextTick keeps
	// its priority over promise jobs across JSC's auto-draining promise queue (the
	// "why" is in js/internal/microtasks.js).
	if exports == nil || !jsc.JSValueIsObject(ctx, exports) do return
	state := get_state_from_ctx(ctx)
	if state == nil do return

	dispatch := get_named(ctx, cast(jsc.JSObjectRef)exports, "dispatch")
	drain := get_named(ctx, cast(jsc.JSObjectRef)exports, "drainNextTicks")
	if dispatch != nil && jsc.JSValueIsObject(ctx, dispatch) {
		jsc.JSValueProtect(ctx, dispatch)
		state.dispatch_fn = dispatch
	}
	if drain != nil && jsc.JSValueIsObject(ctx, drain) {
		jsc.JSValueProtect(ctx, drain)
		state.next_tick_drain = drain
	}
}

// invoke_user_callback runs a user JS callback at an event-loop boundary (timer /
// immediate / I/O / fetch completion) with Node's process.nextTick ordering. It
// calls the callback THROUGH the microtask shim's `dispatch`, which drains the
// nextTick queue before returning — so nextTicks beat promise jobs queued earlier
// in the same turn (checkpoint 1) — then re-drains the nextTicks queued by the
// promise jobs JSC auto-drained on return (checkpoint 2). `args`/`argc` are the
// callback's own arguments; there is no `this` parameter because every call site
// used the default receiver (NULL thisObject → global), which `dispatch` mirrors.
// Falls back to a direct call if the shim is absent (embedder bypass).
invoke_user_callback :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	args: [^]jsc.JSValueRef,
	argc: c.size_t,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	state := get_state_from_ctx(ctx)
	if state == nil || state.dispatch_fn == nil {
		return jsc.JSObjectCallAsFunction(ctx, fn, nil, argc, args, exception)
	}

	// dispatch(fn, ...args): prepend the callback so the shim invokes it and then
	// runs checkpoint 1 in its `finally`.
	n := int(argc) + 1
	dispatch_args := make([]jsc.JSValueRef, n, context.temp_allocator)
	dispatch_args[0] = cast(jsc.JSValueRef)fn
	for i in 0 ..< int(argc) {
		dispatch_args[i + 1] = args[i]
	}
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.dispatch_fn,
		nil,
		c.size_t(n),
		raw_data(dispatch_args),
		exception,
	)
	drain_next_ticks_settled(ctx, state)
	return result
}

// drain_next_ticks_settled runs checkpoint 2: it drains the process.nextTick
// queue, looping until a drain does no work. Each drain call is a C-API boundary,
// so JSC auto-drains its promise jobs between iterations — recreating Node's
// "drain nextTicks, run microtasks, repeat" loop. A throw cannot escape (the shim
// runs nextTick callbacks guarded), but the exception arm is kept for safety.
drain_next_ticks_settled :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil || state.next_tick_drain == nil do return
	for {
		exc: jsc.JSValueRef
		result := jsc.JSObjectCallAsFunction(
			ctx,
			cast(jsc.JSObjectRef)state.next_tick_drain,
			nil,
			0,
			nil,
			&exc,
		)
		if exc != nil {
			report_uncaught(ctx, exc)
			mark_async_failed(ctx)
			return
		}
		if result == nil || !bool(jsc.JSValueToBoolean(ctx, result)) do return
	}
}

// microtask_report_uncaught_cb(error) reports a throw from a nextTick or
// queueMicrotask callback as an uncaught exception and flags the process to exit
// non-zero — mirroring js_callback_trampoline's handling of a throwing timer.
microtask_report_uncaught_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count >= 1 {
		report_uncaught(ctx, arguments[0])
		mark_async_failed(ctx)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// install_internal_modules evaluates the JS built-in modules (util, events,
// assert, buffer) to factory functions, hands them to the loader, and stores
// the resulting resolver on Runtime_State. native_require_cb consults that
// resolver before hitting the filesystem. The loader also eagerly instantiates
// modules that install globals (Buffer), so those exist without a require.
install_internal_modules :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	state := get_state_from_ctx(ctx)
	if state == nil do return

	Module :: struct {
		name:   string,
		source: string,
	}
	modules := [?]Module {
		{"primordials", INTERNAL_PRIMORDIALS},
		{"util", INTERNAL_UTIL},
		{"events", INTERNAL_EVENTS},
		{"assert", INTERNAL_ASSERT},
		{"buffer", INTERNAL_BUFFER},
		{"crypto", INTERNAL_CRYPTO},
		{"stream/web", INTERNAL_STREAMS},
		{"fetch", INTERNAL_FETCH},
		{"abort", INTERNAL_ABORT},
		{"timers/promises", INTERNAL_TIMERS_PROMISES},
		{"encoding", INTERNAL_ENCODING},
		{"url", INTERNAL_URL},
		{"structured_clone", INTERNAL_STRUCTURED_CLONE},
		{"path", INTERNAL_PATH},
		{"sqlite", INTERNAL_SQLITE},
		{"dns", INTERNAL_DNS},
		{"dns/promises", INTERNAL_DNS_PROMISES},
		{"os", INTERNAL_OS},
	}

	factories := jsc.JSObjectMake(ctx, nil, nil)
	for m in modules {
		factory := eval_internal(ctx, m.name, m.source)
		if factory == nil do continue
		set_named(ctx, factories, m.name, factory)
	}

	loader := eval_internal(ctx, "internal:loader", INTERNAL_LOADER)
	if loader == nil || !jsc.JSValueIsObject(ctx, loader) do return

	// Native primitives keyed by module name. The loader passes natives[key] to
	// each factory as its fourth argument, so a module receives its Odin-backed
	// bindings without anything landing on globalThis (cf. install_console).
	natives := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, natives, "crypto", cast(jsc.JSValueRef)make_crypto_bindings(ctx))
	set_named(ctx, natives, "buffer", cast(jsc.JSValueRef)make_buffer_bindings(ctx))
	set_named(ctx, natives, "fetch", cast(jsc.JSValueRef)make_fetch_bindings(ctx))
	set_named(ctx, natives, "sqlite", cast(jsc.JSValueRef)make_sqlite_bindings(ctx))
	set_named(ctx, natives, "dns", cast(jsc.JSValueRef)make_dns_bindings(ctx))
	set_named(ctx, natives, "os", cast(jsc.JSValueRef)make_os_bindings(ctx))

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)factories, cast(jsc.JSValueRef)natives}
	exception: jsc.JSValueRef
	resolver := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)loader,
		nil,
		2,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil {
		report_internal_exception(ctx, "internal:loader", exception)
		return
	}
	if resolver == nil || !jsc.JSValueIsObject(ctx, resolver) do return

	jsc.JSValueProtect(ctx, resolver)
	state.builtin_require = resolver

	// The ESM source transform (js/internal/esm.js) evaluates directly to a
	// `transform(source, url, filename, dirname)` function. It is stored on the
	// state — not registered as a requireable module — so native_require_cb can
	// rewrite `.mjs` files to CommonJS without exposing it to user code.
	esm := eval_internal(ctx, "lava:esm", INTERNAL_ESM)
	if esm != nil && jsc.JSValueIsObject(ctx, esm) {
		jsc.JSValueProtect(ctx, esm)
		state.esm_transform = esm
	}
}

// require_builtin asks the JS resolver for an internal module by specifier.
// Returns nil when the resolver is absent or the module is unknown (the latter
// surfaces as `undefined`, which the caller treats as "not a builtin").
require_builtin :: proc(
	ctx: jsc.JSContextRef,
	specifier: jsc.JSValueRef,
	out_exception: ^jsc.JSValueRef = nil,
) -> jsc.JSValueRef {
	state := get_state_from_ctx(ctx)
	if state == nil || state.builtin_require == nil do return nil
	args := [1]jsc.JSValueRef{specifier}
	exception: jsc.JSValueRef
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.builtin_require,
		nil,
		1,
		raw_data(args[:]),
		&exception,
	)
	// A builtin factory that threw (e.g. a lazy module failing to initialize) must
	// surface that error, not be mistaken for "not a builtin" and fall through to
	// filesystem resolution as a misleading MODULE_NOT_FOUND.
	if exception != nil {
		if out_exception != nil do out_exception^ = exception
		return nil
	}
	if result == nil || jsc.JSValueIsUndefined(ctx, result) do return nil
	return result
}

// install_console builds the full `console` object. CONSOLE_PRELUDE evaluates
// to a factory function `(out, err) => { … }`; we call it with the two native
// write primitives passed directly as arguments. The primitives are therefore
// never exposed on globalThis — no transient leak for user code to capture, and
// no `delete` that would push the global object into JSC's dictionary mode. The
// only property the prelude adds to globalThis is `console` itself.
install_console :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	out_fn := make_native_function(ctx, "__lava_write_out", console_stdout_write_cb)
	err_fn := make_native_function(ctx, "__lava_write_err", console_stderr_write_cb)
	if out_fn == nil || err_fn == nil do return

	factory := eval_internal(ctx, "lava:console", CONSOLE_PRELUDE)
	if factory == nil || !jsc.JSValueIsObject(ctx, factory) do return

	args := [2]jsc.JSValueRef{cast(jsc.JSValueRef)out_fn, cast(jsc.JSValueRef)err_fn}
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)factory,
		nil,
		2,
		raw_data(args[:]),
		&exception,
	)
	if exception != nil do report_internal_exception(ctx, "lava:console", exception)
}

// make_native_function wraps an Odin callback as a standalone JS function value
// without binding it to any object — the caller decides where (if anywhere) it
// is reachable from.
make_native_function :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	callback: jsc.JSObjectCallAsFunctionCallback,
) -> jsc.JSObjectRef {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return nil
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	return jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, callback)
}

// eval_internal runs a trusted, lava-provided JS snippet (a prelude) and returns
// its value. Any exception is reported to stderr rather than surfaced to user
// code; nil is returned in that case.
eval_internal :: proc(ctx: jsc.JSContextRef, name: string, source: string) -> jsc.JSValueRef {
	c_source, source_err := strings.clone_to_cstring(source, context.temp_allocator)
	if source_err != nil do return nil
	js_source := jsc.JSStringCreateWithUTF8CString(c_source)
	defer jsc.JSStringRelease(js_source)

	c_name, name_err := strings.clone_to_cstring(name, context.temp_allocator)
	if name_err != nil do return nil
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, js_source, nil, js_name, 1, &exception)
	if exception != nil {
		report_internal_exception(ctx, name, exception)
		return nil
	}
	return value
}

report_internal_exception :: proc(ctx: jsc.JSContextRef, name: string, exception: jsc.JSValueRef) {
	msg, allocated := jsc_value_to_string_or_default(ctx, exception)
	os.write_string(os.stderr, "lava: failed to initialize ")
	os.write_string(os.stderr, name)
	os.write_string(os.stderr, ": ")
	os.write_string(os.stderr, msg)
	os.write_string(os.stderr, "\n")
	if allocated do delete(msg, context.allocator)
}

install_process :: proc(ctx: jsc.JSContextRef, global: jsc.JSObjectRef) {
	process := jsc.JSObjectMake(ctx, nil, nil)

	set_named(ctx, process, "platform", js_string_value(ctx, PROCESS_PLATFORM))
	set_named(ctx, process, "arch", js_string_value(ctx, PROCESS_ARCH))
	set_named(ctx, process, "pid", jsc.JSValueMakeNumber(ctx, f64(os.get_pid())))

	set_named(ctx, process, "version", js_string_value(ctx, process_version_string()))

	versions := jsc.JSObjectMake(ctx, nil, nil)
	set_named(ctx, versions, "node", js_string_value(ctx, NODE_BASELINE))
	set_named(ctx, process, "versions", cast(jsc.JSValueRef)versions)

	// Node's argv layout is [execPath, scriptPath, ...userArgs] (eval() builds it
	// on the state). Fall back to os.args only for embedders that never set it.
	argv := os.args
	if state := get_state_from_ctx(ctx); state != nil && len(state.script_argv) > 0 {
		argv = state.script_argv
	}
	set_named(ctx, process, "argv", cast(jsc.JSValueRef)build_string_array(ctx, argv))
	set_named(ctx, process, "env", cast(jsc.JSValueRef)build_env_object(ctx))

	inject_native_function(ctx, process, "exit", process_exit_cb)
	inject_native_function(ctx, process, "cwd", process_cwd_cb)

	set_named(ctx, global, "process", cast(jsc.JSValueRef)process)
}

process_version_string :: proc() -> string {
	parts := [?]string{"v", NODE_BASELINE, ".0.0"}
	result, err := strings.concatenate(parts[:], context.temp_allocator)
	if err != nil do return "v22.0.0"
	return result
}

// --- helpers ---

set_named :: proc(
	ctx: jsc.JSContextRef,
	object: jsc.JSObjectRef,
	name: string,
	value: jsc.JSValueRef,
) {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return
	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)
	jsc.JSObjectSetProperty(ctx, object, js_name, value, {}, nil)
}

build_string_array :: proc(ctx: jsc.JSContextRef, items: []string) -> jsc.JSObjectRef {
	if len(items) == 0 {
		return jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	}
	values := make([]jsc.JSValueRef, len(items), context.temp_allocator)
	for item, i in items {
		values[i] = js_string_value(ctx, item)
	}
	return jsc.JSObjectMakeArray(ctx, c.size_t(len(items)), raw_data(values), nil)
}

// build_env_object snapshots the OS environment into a plain object. NOTE: unlike
// Node's live magic `process.env`, this is a one-shot copy — writes/deletes do not
// reach the real environment, so native code reading os.environ later (e.g. a future
// child_process) will not see them. Tracked divergence; revisit when child processes
// land.
build_env_object :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	object := jsc.JSObjectMake(ctx, nil, nil)
	environ, err := os.environ(context.temp_allocator)
	if err != os.ERROR_NONE do return object
	for entry in environ {
		idx := strings.index_byte(entry, '=')
		if idx <= 0 do continue
		set_named(ctx, object, entry[:idx], js_string_value(ctx, entry[idx + 1:]))
	}
	return object
}

// CONSOLE_PRELUDE evaluates to a factory function which, given the two native
// write primitives (stdout, stderr), builds the Node `console` object and
// installs it on globalThis. Implemented in JS (like Node) so util.format
// substitution, value inspection, grouping and table rendering stay simple. The
// primitives arrive as arguments, so they are never visible on globalThis.
CONSOLE_PRELUDE :: #load("js/console.js", string)

// process.nextTick / queueMicrotask ordering shim (factory `(globalThis,
// process) => {}`). Installed after `process` exists; see install_microtasks.
MICROTASK_PRELUDE :: #load("js/internal/microtasks.js", string)

// Internal built-in modules, embedded at compile time. Each evaluates to a
// factory `(require, module, exports) => exports?`; the loader wires them up.
INTERNAL_LOADER :: #load("js/internal/loader.js", string)
INTERNAL_PRIMORDIALS :: #load("js/internal/primordials.js", string)
INTERNAL_UTIL :: #load("js/internal/util.js", string)
INTERNAL_EVENTS :: #load("js/internal/events.js", string)
INTERNAL_ASSERT :: #load("js/internal/assert.js", string)
INTERNAL_BUFFER :: #load("js/internal/buffer.js", string)
INTERNAL_CRYPTO :: #load("js/internal/crypto.js", string)
INTERNAL_STREAMS :: #load("js/internal/streams.js", string)
INTERNAL_FETCH :: #load("js/internal/fetch.js", string)
INTERNAL_ABORT :: #load("js/internal/abort.js", string)
INTERNAL_TIMERS_PROMISES :: #load("js/internal/timers_promises.js", string)
INTERNAL_ENCODING :: #load("js/internal/encoding.js", string)
INTERNAL_URL :: #load("js/internal/url.js", string)
INTERNAL_STRUCTURED_CLONE :: #load("js/internal/structured_clone.js", string)
INTERNAL_PATH :: #load("js/internal/path.js", string)
INTERNAL_SQLITE :: #load("js/internal/sqlite.js", string)
INTERNAL_DNS :: #load("js/internal/dns.js", string)
INTERNAL_DNS_PROMISES :: #load("js/internal/dns_promises.js", string)
INTERNAL_OS :: #load("js/internal/os.js", string)

// ESM-to-CommonJS source transform. Stored on Runtime_State rather than handed to
// the module resolver (see install_internal_modules); evaluates to a function.
INTERNAL_ESM :: #load("js/internal/esm.js", string)
