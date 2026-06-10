package lava_runtime

import "core:os"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

NODE_BASELINE :: "22"
ENGINE_TARGET :: "JavaScriptCore"

when ODIN_OS == .Linux {
	EVENT_LOOP_TARGET :: "native io_uring/epoll"
} else when ODIN_OS == .Darwin {
	EVENT_LOOP_TARGET :: "native kqueue"
} else when ODIN_OS == .Windows {
	EVENT_LOOP_TARGET :: "native windows-iocp"
} else {
	EVENT_LOOP_TARGET :: "unknown-backend"
}

Status :: enum {
	Ok,
	Native_Runtime_Unavailable,
	Read_Error,
	Invalid_Input,
	Execution_Error,
}

Result :: struct {
	status:       Status,
	exit_code:    int,
	message:      string,
	is_allocated: bool,
}

result_destroy :: proc(res: ^Result) {
	if res.is_allocated && len(res.message) > 0 {
		delete(res.message)
	}
	res^ = Result{}
}

// echo_result mirrors REPL behavior: when true (the `lava eval` path) the
// script's completion value is returned for printing. `lava run` passes false so
// running a file never echoes a trailing expression value, matching `node file`
// (and avoiding JSC-version-dependent completion values like `[object Promise]`).
eval :: proc(source: string, source_name := "<eval>", loop: ^eventloop.Loop = nil, echo_result := false) -> Result {
	if len(source) == 0 {
		return Result{status = .Invalid_Input, exit_code = 2, message = "empty JavaScript source"}
	}

	if strings.has_prefix(source_name, "node:") {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "node: specifiers are module names, not eval source names",
		}
	}

	// A JS runtime must survive writes to closed pipes/sockets (Node parity):
	// see signals_posix.odin. Installed per eval — the call is idempotent.
	ignore_sigpipe()

	// Per-eval temp arena boundary, mirroring the per-tick reset in
	// eventloop.run_once and the per-require reset in native_require_cb. It
	// reclaims the scratch allocated around the loop (setup_module_environment,
	// the .mjs entry wrap, the script/source-name cstrings) — which the per-tick
	// reset covers only when a loop is attached — so embedders calling eval
	// repeatedly without a loop do not accumulate it. Result.message is on
	// context.allocator, so nothing returned escapes through the temp arena.
	defer free_all(context.temp_allocator)

	// A custom global class gives the global object a private-data slot, where we
	// stash Runtime_State (loop + module cache) out of reach of user JavaScript.
	global_class := make_global_class()
	ctx := jsc.JSGlobalContextCreate(global_class)
	if ctx == nil {
		jsc.JSClassRelease(global_class)
		return native_runtime_unavailable()
	}
	defer jsc.JSClassRelease(global_class)
	defer jsc.JSGlobalContextRelease(ctx)

	state := new_runtime_state(loop)
	jsc.JSObjectSetPrivate(
		jsc.JSContextGetGlobalObject(cast(jsc.JSContextRef)ctx),
		cast(rawptr)state,
	)
	// Runs before the context is released (defers execute in reverse order), so
	// JSValueUnprotect on cached modules still has a live context.
	defer destroy_runtime_state(cast(jsc.JSContextRef)ctx, state)

	setup_module_environment(cast(jsc.JSContextRef)ctx, source_name, loop)

	// ESM entrypoints (.mjs) are rewritten to CommonJS via the same transform the
	// loader applies to imported .mjs modules; script (.js) and `lava eval`
	// sources run unchanged.
	eval_source := source
	mjs_wrapped: string
	mjs_allocated := false
	defer if mjs_allocated do delete(mjs_wrapped)
	if strings.has_suffix(source_name, ".mjs") {
		wrap_exception: jsc.JSValueRef
		wrapped, ok := esm_wrap_source(
			cast(jsc.JSContextRef)ctx,
			source,
			source_name,
			&wrap_exception,
		)
		if !ok {
			msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, wrap_exception)
			return Result {
				status = .Execution_Error,
				exit_code = 1,
				message = msg,
				is_allocated = allocated,
			}
		}
		eval_source = wrapped
		mjs_wrapped = wrapped
		mjs_allocated = true
	}

	script := js_string_from_string(eval_source)
	if script == nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source string",
		}
	}
	defer jsc.JSStringRelease(script)

	c_source_name, c_source_name_err := strings.clone_to_cstring(
		source_name,
		context.temp_allocator,
	)
	if c_source_name_err != nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source name",
		}
	}

	source_url := jsc.JSStringCreateWithUTF8CString(c_source_name)
	if source_url == nil {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "could not allocate JavaScript source URL object",
		}
	}
	defer jsc.JSStringRelease(source_url)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(
		cast(jsc.JSContextRef)ctx,
		script,
		nil,
		source_url,
		1,
		&exception,
	)

	if exception != nil {
		msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, exception)
		return Result {
			status = .Execution_Error,
			exit_code = 1,
			message = msg,
			is_allocated = allocated,
		}
	}

	if loop != nil {
		eventloop.run(loop)
	}

	exit_code := resolve_exit_code(cast(jsc.JSContextRef)ctx, state)

	if !echo_result || value == nil || jsc.JSValueIsUndefined(cast(jsc.JSContextRef)ctx, value) {
		return Result{status = .Ok, exit_code = exit_code}
	}

	msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, value)
	return Result{status = .Ok, exit_code = exit_code, message = msg, is_allocated = allocated}
}

// resolve_exit_code computes the final process exit code after the event loop
// drains. An uncaught async exception or an unhandled promise rejection forces a
// non-zero exit; otherwise a script-assigned process.exitCode is honored, matching
// Node. (process.exit() is handled separately and terminates immediately.)
resolve_exit_code :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State) -> int {
	if state != nil && state.async_failed do return 1
	return process_exit_code(ctx)
}

process_exit_code :: proc(ctx: jsc.JSContextRef) -> int {
	global := jsc.JSContextGetGlobalObject(ctx)
	process := get_named(ctx, global, "process")
	if process == nil || !jsc.JSValueIsObject(ctx, process) do return 0
	code := get_named(ctx, cast(jsc.JSObjectRef)process, "exitCode")
	if code == nil || jsc.JSValueIsUndefined(ctx, code) || jsc.JSValueIsNull(ctx, code) do return 0
	n := jsc.JSValueToNumber(ctx, code, nil)
	if n != n do return 0 // NaN guard (e.g. exitCode set to a non-numeric value)
	return int(n)
}

run_file :: proc(path: string, loop: ^eventloop.Loop = nil) -> Result {
	if len(path) == 0 {
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "missing JavaScript file path",
		}
	}

	data, err := os.read_entire_file(path, context.allocator)
	if err != os.ERROR_NONE {
		return Result {
			status = .Read_Error,
			exit_code = 1,
			message = "could not read JavaScript file",
		}
	}
	defer delete(data)

	return eval(string(data), path, loop)
}

native_runtime_unavailable :: proc() -> Result {
	return Result {
		status = .Native_Runtime_Unavailable,
		exit_code = 70,
		message = "native runtime unavailable: install JavaScriptCoreGTK development package",
	}
}

is_success :: proc(result: Result) -> bool {
	return result.status == .Ok
}

js_string_from_string :: proc(value: string) -> jsc.JSStringRef {
	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)
	if err != nil {
		return nil
	}
	return jsc.JSStringCreateWithUTF8CString(c_value)
}

value_to_string :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> (string, bool) {
	exception: jsc.JSValueRef
	js_string := jsc.JSValueToStringCopy(ctx, value, &exception)
	if js_string == nil {
		return "JavaScript value could not be converted to string", false
	}
	defer jsc.JSStringRelease(js_string)

	max_size := int(jsc.JSStringGetMaximumUTF8CStringSize(js_string))
	if max_size <= 0 {
		return "", false
	}

	// Allocate the result buffer directly (one allocation instead of a temp
	// buffer plus a clone). JSStringGetUTF8CString writes a NUL-terminated
	// string, so the JS string occupies buffer[:written-1].
	buffer := make([]byte, max_size, context.allocator)
	written := int(
		jsc.JSStringGetUTF8CString(
			js_string,
			raw_data(buffer),
			jsc.JSStringGetMaximumUTF8CStringSize(js_string),
		),
	)
	if written <= 1 {
		delete(buffer)
		return "", false
	}

	return string(buffer[:written - 1]), true
}
