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
	loop:         ^eventloop.Loop,
	module_cache: map[string]jsc.JSValueRef, // resolved path / specifier -> module.exports
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

console_write :: proc(
	fd: ^os.File,
	ctx: jsc.JSContextRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
) {
	count := int(argument_count)
	for i in 0 ..< count {
		if i > 0 do os.write_string(fd, " ")
		text, allocated := jsc_value_to_string_or_default(ctx, arguments[i])
		os.write_string(fd, text)
		if allocated do delete(text, context.allocator)
	}
	os.write_string(fd, "\n")
}

console_log_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_write(os.stdout, ctx, argument_count, arguments)
	return jsc.JSValueMakeUndefined(ctx)
}

console_error_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	console_write(os.stderr, ctx, argument_count, arguments)
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

	console := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, console, "log", console_log_cb)
	inject_native_function(ctx, console, "info", console_log_cb)
	inject_native_function(ctx, console, "debug", console_log_cb)
	inject_native_function(ctx, console, "error", console_error_cb)
	inject_native_function(ctx, console, "warn", console_error_cb)
	set_named(ctx, global, "console", cast(jsc.JSValueRef)console)

	install_process(ctx, global)
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
