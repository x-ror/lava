package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Runtime_State holds per-context state. A pointer to it lives in the global
// object's private data slot (see make_global_class) instead of being exposed
// to JavaScript, so user code can neither read nor corrupt the loop pointer.
Runtime_State :: struct {
	loop:            ^eventloop.Loop,
	module_cache:    map[string]jsc.JSValueRef, // resolved path / specifier -> module.exports
	builtin_require: jsc.JSValueRef, // JS resolver for internal modules (events/util/assert/buffer); GC-protected
	// Set when an uncaught exception escapes an async callback or a promise
	// rejects with no handler. The process then exits non-zero even though the
	// initial JSEvaluateScript returned cleanly (see resolve_exit_code).
	async_failed:      bool,
	rejection_handler: jsc.JSValueRef, // GC-protected fn registered with JSC; unprotected on destroy
}

// JS_Callback bridges a JS function into an event-loop Callback. The function
// is GC-protected for the lifetime of the binding so JavaScriptCore cannot
// collect it between scheduling and firing.
JS_Callback :: struct {
	ctx:       jsc.JSContextRef,
	func:      jsc.JSObjectRef,
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
	state.module_cache = make(map[string]jsc.JSValueRef)
	return state
}

destroy_runtime_state :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) {
	if state == nil do return
	for key, value in state.module_cache {
		jsc.JSValueUnprotect(ctx, value)
		delete(key)
	}
	delete(state.module_cache)
	if state.builtin_require != nil do jsc.JSValueUnprotect(ctx, state.builtin_require)
	if state.rejection_handler != nil do jsc.JSValueUnprotect(ctx, state.rejection_handler)
	free(state)
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
	cloned, err := strings.clone(key)
	if err != nil do return
	jsc.JSValueProtect(ctx, value)
	state.module_cache[cloned] = value
}

// --- JS callback bridge ---

make_js_callback :: proc(
	ctx: jsc.JSContextRef,
	fn: jsc.JSObjectRef,
	repeating: bool,
) -> ^JS_Callback {
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
	cb := new(JS_Callback)
	cb.ctx = ctx
	cb.func = fn
	cb.repeating = repeating
	return cb
}

js_callback_trampoline :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	cb := cast(^JS_Callback)user_data
	if cb == nil do return

	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(cb.ctx, cb.func, nil, 0, nil, &exception)
	if exception != nil {
		report_uncaught(cb.ctx, exception)
		mark_async_failed(cb.ctx)
	}

	// Non-repeating callbacks (setTimeout/setImmediate/microtasks) fire once;
	// release their GC protection and heap binding. Repeating timers keep the
	// binding alive for the next tick. NOTE: clearInterval leaks the binding —
	// the loop drops the timer without firing it. Tracked as a follow-up.
	if !cb.repeating {
		jsc.JSValueUnprotect(cb.ctx, cast(jsc.JSValueRef)cb.func)
		free(cb)
	}
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

make_js_error :: proc(ctx: jsc.JSContextRef, message: string) -> jsc.JSValueRef {
	msg := js_string_value(ctx, message)
	args := [1]jsc.JSValueRef{msg}
	err := jsc.JSObjectMakeError(ctx, 1, raw_data(args[:]), nil)
	return cast(jsc.JSValueRef)err
}

// --- Timer / scheduling callbacks ---

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
	if delay < 0 do delay = 0

	cb := make_js_callback(ctx, fn, false)
	id := eventloop.set_timeout(loop, js_callback_trampoline, u64(delay), cb)
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
	if interval < 0 do interval = 0

	cb := make_js_callback(ctx, fn, true)
	id := eventloop.set_interval(loop, js_callback_trampoline, u64(interval), cb)
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

	cb := make_js_callback(ctx, fn, false)
	id := eventloop.set_immediate(loop, js_callback_trampoline, cb)
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

	id := u64(jsc.JSValueToNumber(ctx, arguments[0], nil))
	eventloop.clear_timeout(loop, id)
	return jsc.JSValueMakeUndefined(ctx)
}

queue_microtask_cb :: proc "c" (
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

	cb := make_js_callback(ctx, fn, false)
	eventloop.queue_microtask(loop, js_callback_trampoline, cb)
	return jsc.JSValueMakeUndefined(ctx)
}

process_next_tick_cb :: proc "c" (
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

	cb := make_js_callback(ctx, fn, false)
	eventloop.queue_next_tick(loop, js_callback_trampoline, cb)
	return jsc.JSValueMakeUndefined(ctx)
}

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
	code := 0
	if argument_count >= 1 do code = int(jsc.JSValueToNumber(ctx, arguments[0], nil))
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
	inject_native_function(ctx, global, "queueMicrotask", queue_microtask_cb)

	install_console(ctx, global)
	install_internal_modules(ctx, global)

	install_process(ctx, global)
	install_rejection_tracker(ctx)
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
		{"util", INTERNAL_UTIL},
		{"events", INTERNAL_EVENTS},
		{"assert", INTERNAL_ASSERT},
		{"buffer", INTERNAL_BUFFER},
		{"crypto", INTERNAL_CRYPTO},
		{"fetch", INTERNAL_FETCH},
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
}

// require_builtin asks the JS resolver for an internal module by specifier.
// Returns nil when the resolver is absent or the module is unknown (the latter
// surfaces as `undefined`, which the caller treats as "not a builtin").
require_builtin :: proc(ctx: jsc.JSContextRef, specifier: jsc.JSValueRef) -> jsc.JSValueRef {
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
	if exception != nil do return nil
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
	jsc.JSObjectCallAsFunction(ctx, cast(jsc.JSObjectRef)factory, nil, 2, raw_data(args[:]), &exception)
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
eval_internal :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	source: string,
) -> jsc.JSValueRef {
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

report_internal_exception :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	exception: jsc.JSValueRef,
) {
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

	set_named(ctx, process, "argv", cast(jsc.JSValueRef)build_string_array(ctx, os.args))
	set_named(ctx, process, "env", cast(jsc.JSValueRef)build_env_object(ctx))

	inject_native_function(ctx, process, "nextTick", process_next_tick_cb)
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

// Internal built-in modules, embedded at compile time. Each evaluates to a
// factory `(require, module, exports) => exports?`; the loader wires them up.
INTERNAL_LOADER :: #load("js/internal/loader.js", string)
INTERNAL_UTIL :: #load("js/internal/util.js", string)
INTERNAL_EVENTS :: #load("js/internal/events.js", string)
INTERNAL_ASSERT :: #load("js/internal/assert.js", string)
INTERNAL_BUFFER :: #load("js/internal/buffer.js", string)
INTERNAL_CRYPTO :: #load("js/internal/crypto.js", string)
INTERNAL_FETCH :: #load("js/internal/fetch.js", string)
