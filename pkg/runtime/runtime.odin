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

eval :: proc(source: string, source_name := "<eval>", loop: ^eventloop.Loop = nil) -> Result {
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

	ctx := jsc.JSGlobalContextCreate(nil)
	if ctx == nil {
		return native_runtime_unavailable()
	}
	defer jsc.JSGlobalContextRelease(ctx)

	setup_module_environment(cast(jsc.JSContextRef)ctx, source_name, loop)

	script := js_string_from_string(source)
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
		eventloop.run_until_idle(loop)
	}

	if value == nil || jsc.JSValueIsUndefined(cast(jsc.JSContextRef)ctx, value) {
		return Result{status = .Ok, exit_code = 0}
	}

	msg, allocated := value_to_string(cast(jsc.JSContextRef)ctx, value)
	return Result{status = .Ok, exit_code = 0, message = msg, is_allocated = allocated}
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

	buffer := make([]byte, max_size, context.temp_allocator)
	written := int(
		jsc.JSStringGetUTF8CString(
			js_string,
			raw_data(buffer),
			jsc.JSStringGetMaximumUTF8CStringSize(js_string),
		),
	)
	if written <= 1 {
		return "", false
	}

	result, err := strings.clone_from_bytes(buffer[:written - 1], context.allocator)
	if err != nil {
		return "JavaScript string allocation failed", false
	}
	return result, true
}
