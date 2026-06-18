package lava_runtime

import "core:os"
import "core:path/filepath"
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

// release_global_context_after_eval frees the JSC global context when eval
// returns — except on Windows. Releasing the context tears down the whole JSC VM
// (JIT/GC threads, ICU); on Windows, doing that right before the CLI's os.exit()
// poisons process teardown — the subsequent ExitProcess DLL-detach fails and the
// process exits 127 (ERROR_PROC_NOT_FOUND) even though the script ran fine.
//
// Today eval is a one-shot-per-process CLI entry, so leaking the VM on Windows is
// harmless (the OS reclaims it on exit, as node/jsc/bun do). If Lava ever grows an
// embedded / repeated-eval Windows use case, this is the policy to revisit: the
// teardown ordering must be fixed rather than skipped.
release_global_context_after_eval :: proc(ctx: jsc.JSGlobalContextRef) {
	when ODIN_OS != .Windows {
		jsc.JSGlobalContextRelease(ctx)
	}
}

// echo_result mirrors REPL behavior: when true (the `lava eval` path) the
// script's completion value is returned for printing. `lava run` passes false so
// running a file never echoes a trailing expression value, matching `node file`
// (and avoiding JSC-version-dependent completion values like `[object Promise]`).
//
// OWNERSHIP: a non-nil `loop` is CONSUMED — eval destroys it before returning on
// EVERY path (a pre-flight input rejection, a thrown top-level exception, or a
// clean run), and for any path that created handles it does so while the context
// they are GC-protected against is still alive. Callers must not destroy the loop
// themselves (a double destroy closes fd 0); they only init it and pass it in.
eval :: proc(
	source: string,
	source_name := "<eval>",
	loop: ^eventloop.Loop = nil,
	echo_result := false,
	script_args: []string = nil,
) -> Result {
	// eval consumes the loop on EVERY path (see the OWNERSHIP note above). These two
	// pre-flight rejections return before the JS context (and the deferred teardown
	// below) exists, so they destroy the loop explicitly. It holds no handles yet, so
	// this single destroy needs no live context.
	if len(source) == 0 {
		if loop != nil do eventloop.destroy(loop)
		return Result{status = .Invalid_Input, exit_code = 2, message = "empty JavaScript source"}
	}

	if strings.has_prefix(source_name, "node:") {
		if loop != nil do eventloop.destroy(loop)
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

	// Configure JSC before the first JSGlobalContextCreate. On Windows this disables
	// the (buggy on this bun-webkit build) baseline JIT tier and runs JSC's proper
	// process bring-up — without it, heavy JS corrupts memory mid-execution
	// (0xC0000409, surfaced as exit 127). See pkg/jsc/jsc_init_windows.cpp for the
	// full rationale. Idempotent; a no-op on Linux/macOS.
	jsc.lava_jsc_init()

	// A custom global class gives the global object a private-data slot, where we
	// stash Runtime_State (loop + module cache) out of reach of user JavaScript.
	global_class := make_global_class()
	ctx := jsc.JSGlobalContextCreate(global_class)
	if ctx == nil {
		jsc.JSClassRelease(global_class)
		// Still consume the loop (no context was created, so no handles exist).
		if loop != nil do eventloop.destroy(loop)
		return native_runtime_unavailable()
	}
	defer jsc.JSClassRelease(global_class)
	defer release_global_context_after_eval(ctx)

	state := new_runtime_state(loop)
	// Build Node's process.argv = [execPath, scriptPath, ...userArgs]. argv[0] is
	// the lava binary (absolute, like Node's execPath); argv[1] is the absolute
	// script path (omitted for `lava eval`, where there is no script file). Built in
	// the per-eval temp arena, which outlives install_process (see the defer above).
	state.script_argv = build_process_argv(source_name, script_args)
	jsc.JSObjectSetPrivate(
		jsc.JSContextGetGlobalObject(cast(jsc.JSContextRef)ctx),
		cast(rawptr)state,
	)
	// Runs before the context is released (defers execute in reverse order), so
	// JSValueUnprotect on cached modules still has a live context.
	defer destroy_runtime_state(cast(jsc.JSContextRef)ctx, state)

	// eval owns the loop's teardown (see the OWNERSHIP note above). A deferred
	// destroy — not a tail call after eventloop.run — so that EVERY return once the
	// context exists tears the loop down: a thrown top-level exception (which may
	// already have created timers/sockets), an .mjs wrap error, or a source-string
	// allocation failure would otherwise return the loop alive with GC-protected
	// callbacks stranded. Declared after destroy_runtime_state so it fires first
	// (LIFO), and before the context release, so dispose hooks still see a live
	// context. On abnormal returns it first stops active fetches and joins both the
	// fetch and node:dns resolver workers, so no background thread can post into a
	// destroyed loop/context. On the success path it runs after eventloop.run returns.
	defer if loop != nil {
		fetch_shutdown_active(state)
		dns_shutdown_active(state)
		eventloop.destroy(loop)
	}

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
	} else {
		// Register the CommonJS/script entry in the module cache before it runs, so
		// requiring the entry by path returns the same instance (and an entry-
		// involved require cycle terminates instead of re-executing the entry). The
		// .mjs entry handles this itself via __lava_precache in its transformed body.
		register_entry_module(cast(jsc.JSContextRef)ctx, state, source_name)
	}

	// Drain the top-level turn's process.nextTick queue *before* JSEvaluateScript
	// returns: JSC auto-drains its promise jobs at that boundary, so a nextTick
	// queued at top level would otherwise lose to a promise job queued before it
	// (Node runs nextTick first). There is no native hook between "script body done"
	// and "JSC drains", so we append the drain as a trailing statement — the same
	// role dispatch plays for event-loop callbacks. It is a VariableStatement (empty
	// completion value) so it does not clobber the script's completion value used by
	// `lava eval`'s echo; the leading "\n;" guards a trailing line comment / missing
	// semicolon; typeof keeps it a no-op if the microtask shim failed to install.
	TOP_LEVEL_DRAIN :: "\n;var __lava_tl_drain = (typeof __lavaDrainNextTicks === 'function') && __lavaDrainNextTicks();\n"
	if combined, concat_err := strings.concatenate(
		{eval_source, TOP_LEVEL_DRAIN},
		context.temp_allocator,
	); concat_err == nil {
		eval_source = combined
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

	// Refresh the cached entry exports: a CommonJS entry body may have reassigned
	// module.exports, so the pre-eval partial registered above is now stale.
	if !mjs_allocated {
		register_entry_module(cast(jsc.JSContextRef)ctx, state, source_name)
	}

	// The drain appended above ran nextTicks queued synchronously by the top-level
	// body; this runs the ones queued by the promise jobs JSC auto-drained when
	// JSEvaluateScript returned — so the nextTick queue is empty before the loop's
	// first timer/I/O phase, since Node drains nextTicks ahead of timers. Same
	// after-the-boundary re-drain that invoke_user_callback does per callback.
	drain_next_ticks_settled(cast(jsc.JSContextRef)ctx, state)

	if loop != nil {
		eventloop.run(loop)
		// Loop teardown is the deferred eventloop.destroy declared above — it covers
		// this success path and every early return once the context exists.
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
	// JSValueGetType classifies the value in one call (Object vs the Undefined/Null
	// switch below); the JSValueIs* predicates are equally ABI-safe now that they
	// return a 1-byte `bool` (see cmd/lava jsc_value_predicates, #159) — the former
	// "unreliable across the FFI" note described the retired `b32` return.
	if process == nil || jsc.JSValueGetType(ctx, process) != .Object do return 0
	code := get_named(ctx, cast(jsc.JSObjectRef)process, "exitCode")
	if code == nil do return 0
	#partial switch jsc.JSValueGetType(ctx, code) {
	case .Undefined, .Null:
		return 0
	}
	n := jsc.JSValueToNumber(ctx, code, nil)
	if n != n do return 0 // NaN guard (e.g. exitCode set to a non-numeric value)
	return int(n)
}

run_file :: proc(
	path: string,
	loop: ^eventloop.Loop = nil,
	script_args: []string = nil,
) -> Result {
	if len(path) == 0 {
		if loop != nil do eventloop.destroy(loop)
		return Result {
			status = .Invalid_Input,
			exit_code = 2,
			message = "missing JavaScript file path",
		}
	}

	data, err := os.read_entire_file(path, context.allocator)
	if err != os.ERROR_NONE {
		if loop != nil do eventloop.destroy(loop)
		return Result {
			status = .Read_Error,
			exit_code = 1,
			message = "could not read JavaScript file",
		}
	}
	defer delete(data)

	return eval(string(data), path, loop, false, script_args)
}

// build_process_argv assembles Node's process.argv: [execPath, scriptPath,
// ...userArgs]. execPath is the lava binary (absolutized like Node's execPath);
// scriptPath is the absolute entry path, omitted for `lava eval` (no script file).
// Allocated in the temp arena (valid for the duration of the eval call).
build_process_argv :: proc(source_name: string, script_args: []string) -> []string {
	argv := make([dynamic]string, 0, len(script_args) + 2, context.temp_allocator)

	exec_path := "lava"
	if len(os.args) > 0 {
		exec_path = os.args[0]
		if abs_exec, abs_err := filepath.abs(exec_path, context.temp_allocator);
		   abs_err == os.ERROR_NONE && len(abs_exec) > 0 {
			exec_path = abs_exec
		}
	}
	append(&argv, exec_path)

	if source_name != "<eval>" {
		script_path := source_name
		if abs_script, abs_err := filepath.abs(source_name, context.temp_allocator);
		   abs_err == os.ERROR_NONE && len(abs_script) > 0 {
			script_path = abs_script
		}
		append(&argv, script_path)
	}

	for arg in script_args do append(&argv, arg)
	return argv[:]
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
