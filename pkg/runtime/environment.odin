package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Контекст для завантажувача модулів
Module_Context :: struct {
	filename: string,
	dirname:  string,
}

// Головна функція, яка налаштовує середовище під Node.js (Тепер приймає loop)
setup_module_environment :: proc(ctx: jsc.JSContextRef, file_path: string, loop: ^eventloop.Loop) {
	global_obj := jsc.JSContextGetGlobalObject(ctx)

	// 1. Розраховуємо __filename та __dirname
	abs_path, _ := filepath.abs(file_path, context.temp_allocator)
	dir_path := filepath.dir(abs_path)

	// 2. Інжектуємо __filename та __dirname як глобальні змінні
	inject_global_string(ctx, global_obj, "__filename", abs_path)
	inject_global_string(ctx, global_obj, "__dirname", dir_path)

	// 2.5. Встановлюємо глобальні об'єкти Node (console, process, таймери).
	// Вказівник на Event Loop живе у приватних даних global object, а не у JS.
	install_globals(ctx, loop)

	// 3. Інжектуємо функцію require
	req_name := jsc.JSStringCreateWithUTF8CString("require")
	defer jsc.JSStringRelease(req_name)

	req_func := jsc.JSObjectMakeFunctionWithCallback(ctx, req_name, native_require_cb)

	// Виправлено: явне приведення типов cast(jsc.JSValueRef)
	jsc.JSObjectSetProperty(ctx, global_obj, req_name, cast(jsc.JSValueRef)req_func, {}, nil)

	// 4. Створюємо та інжектуємо об'єкт module та module.children
	module_obj := jsc.JSObjectMake(ctx, nil, nil)
	children_arr := jsc.JSObjectMake(ctx, nil, nil)

	child_len_name := jsc.JSStringCreateWithUTF8CString("length")
	defer jsc.JSStringRelease(child_len_name)
	jsc.JSObjectSetProperty(
		ctx,
		children_arr,
		child_len_name,
		jsc.JSValueMakeNumber(ctx, 1),
		{},
		nil,
	)

	module_name := jsc.JSStringCreateWithUTF8CString("module")
	children_name := jsc.JSStringCreateWithUTF8CString("children")
	defer jsc.JSStringRelease(module_name)
	defer jsc.JSStringRelease(children_name)

	// Виправлено: додано касти до JSValueRef для властивостей об'єкта
	jsc.JSObjectSetProperty(
		ctx,
		module_obj,
		children_name,
		cast(jsc.JSValueRef)children_arr,
		{},
		nil,
	)
	jsc.JSObjectSetProperty(ctx, global_obj, module_name, cast(jsc.JSValueRef)module_obj, {}, nil)
}

inject_global_string :: proc(
	ctx: jsc.JSContextRef,
	global_obj: jsc.JSObjectRef,
	name: string,
	value: string,
) {
	c_name, c_name_err := strings.clone_to_cstring(name, context.temp_allocator)
	if c_name_err != nil do return
	c_value, c_value_err := strings.clone_to_cstring(value, context.temp_allocator)
	if c_value_err != nil do return

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	js_val_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_name)
	defer jsc.JSStringRelease(js_val_str)

	js_val := jsc.JSValueMakeString(ctx, js_val_str)
	jsc.JSObjectSetProperty(ctx, global_obj, js_name, js_val, {}, nil)
}

// node:path is implemented in JavaScript (js/internal/path.js) so the POSIX and
// Windows normalize/resolve/relative semantics match Node exactly; it is wired
// through the internal-module loader like the other built-ins.

fs_read_file_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	data, err := os.read_entire_file(path_str, context.allocator)
	if err != os.ERROR_NONE do return jsc.JSValueMakeUndefined(ctx)

	// With an explicit encoding (readFileSync(path, 'utf8')) Node returns a
	// string; with no encoding it returns a Buffer. We model the latter as a
	// Uint8Array so binary data survives intact instead of being mangled by a
	// lossy UTF-8 decode.
	if argument_count >= 2 && jsc.JSValueIsString(ctx, args[1]) {
		defer delete(data, context.allocator)
		return js_string_value(ctx, string(data))
	}

	// Hand ownership of `data` to JavaScriptCore; fs_buffer_deallocator frees it
	// when the typed array is collected.
	array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
		ctx,
		.Uint8Array,
		raw_data(data),
		c.size_t(len(data)),
		fs_buffer_deallocator,
		nil,
		nil,
	)
	return cast(jsc.JSValueRef)array
}

fs_buffer_deallocator :: proc "c" (bytes: rawptr, deallocator_context: rawptr) {
	context = runtime.default_context()
	if bytes != nil do free(bytes)
}

// FS_Read_Request carries an async fs.readFile result from the (synchronous) read
// to the poll-phase callback that invokes the JS callback with (err, data).
FS_Read_Request :: struct {
	ctx:       jsc.JSContextRef,
	callback:  jsc.JSObjectRef, // GC-protected until the completion fires
	data:      []byte, // file contents on success (ownership handed to JSC for Buffer)
	ok:        bool,
	as_string: bool, // an encoding was supplied → deliver a string, else a Uint8Array
	err_msg:   string,
	err_code:  string,
	err_path:  string,
}

// fs.readFile(path[, options], callback). The file is read synchronously and the
// callback is delivered on the event loop's poll phase (queue_io_callback), so it
// runs before any setImmediate scheduled in the same turn — matching Node's
// I/O-callback ordering. (This is not yet threadpool-backed async I/O; the read
// itself is synchronous, but the callback timing matches.)
fs_read_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile requires a path and a callback")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	args := arguments[:int(argument_count)]
	callback := callback_arg(ctx, args[argument_count - 1])
	if callback == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile callback must be a function")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	// Options sit between path and callback: a string encoding, or { encoding }.
	as_string := false
	if argument_count >= 3 {
		opt := args[1]
		if jsc.JSValueIsString(ctx, opt) {
			as_string = true
		} else if jsc.JSValueIsObject(ctx, opt) {
			enc := get_named(ctx, cast(jsc.JSObjectRef)opt, "encoding")
			if enc != nil && jsc.JSValueIsString(ctx, enc) do as_string = true
		}
	}

	req := new(FS_Read_Request)
	req.ctx = ctx
	req.callback = callback
	req.as_string = as_string
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	data, err := os.read_entire_file(path_str, context.allocator)
	if err != os.ERROR_NONE {
		req.ok = false
		req.err_code = os.exists(path_str) ? "EIO" : "ENOENT"
		req.err_path, _ = strings.clone(path_str, context.allocator)
		req.err_msg = fmt.aprintf(
			"%s: error reading file, open '%s'",
			req.err_code,
			path_str,
			allocator = context.allocator,
		)
	} else {
		req.ok = true
		req.data = data
	}

	loop := get_loop_from_ctx(ctx)
	if loop != nil {
		eventloop.queue_io_callback(loop, fs_read_complete_cb, req)
	} else {
		// No loop bound (e.g. bare eval): deliver inline so the callback still runs.
		fs_read_complete_cb(nil, req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs_read_complete_cb runs in the poll phase and invokes the JS callback with the
// Node (err, data) convention, then releases the request.
fs_read_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Read_Request)user_data
	if req == nil do return
	ctx := req.ctx

	call_args: [2]jsc.JSValueRef
	if req.ok {
		call_args[0] = jsc.JSValueMakeNull(ctx)
		if req.as_string {
			call_args[1] = js_string_value(ctx, string(req.data))
			delete(req.data, context.allocator)
		} else {
			// Hand the bytes to JSC; fs_buffer_deallocator frees them on collection.
			array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
				ctx,
				.Uint8Array,
				raw_data(req.data),
				c.size_t(len(req.data)),
				fs_buffer_deallocator,
				nil,
				nil,
			)
			call_args[1] = cast(jsc.JSValueRef)array
		}
	} else {
		err := make_js_error(ctx, req.err_msg)
		if jsc.JSValueIsObject(ctx, err) {
			err_obj := cast(jsc.JSObjectRef)err
			set_named(ctx, err_obj, "code", js_string_value(ctx, req.err_code))
			set_named(ctx, err_obj, "path", js_string_value(ctx, req.err_path))
			set_named(ctx, err_obj, "syscall", js_string_value(ctx, "open"))
		}
		call_args[0] = err
		call_args[1] = jsc.JSValueMakeUndefined(ctx)
		if len(req.err_msg) > 0 do delete(req.err_msg, context.allocator)
		if len(req.err_path) > 0 do delete(req.err_path, context.allocator)
	}

	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(ctx, req.callback, nil, 2, raw_data(call_args[:]), &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)req.callback)
	free(req)
}

fs_exists_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeBoolean(ctx, false)

	args := arguments[:int(argument_count)]
	path_str, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(path_str, context.allocator)

	return jsc.JSValueMakeBoolean(ctx, b32(module_file_exists(path_str)))
}

noop_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	return jsc.JSValueMakeUndefined(ctx)
}

native_require_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	// All the path/wrapper scratch in this call is temporary; reclaim it on exit
	// instead of letting the per-thread arena grow unbounded across requires.
	defer free_all(context.temp_allocator)
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	state := get_state_from_ctx(ctx)

	args := arguments[:int(argument_count)]
	specifier, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(specifier, context.allocator)

	// Module cache: a previously-loaded module (by specifier or resolved path)
	// returns its existing exports so top-level code runs exactly once.
	if cached, ok := module_cache_get(state, specifier); ok {
		return cached
	}

	// 0. JS-implemented built-ins (util, events, assert, buffer, and their
	// node:-prefixed / assert-strict aliases). The resolver returns undefined
	// for anything it does not own, so we fall through to the native builtins
	// and the filesystem below.
	if builtin := require_builtin(ctx, args[0]); builtin != nil {
		module_cache_put(ctx, state, specifier, builtin)
		return builtin
	}

	// node:path is served by the JS internal-module loader above (require_builtin).

	if specifier == "node:fs" {
		fs_obj := jsc.JSObjectMake(ctx, nil, nil)

		inject_native_function(ctx, fs_obj, "readFile", fs_read_file_cb)
		inject_native_function(ctx, fs_obj, "readFileSync", fs_read_file_sync_cb)
		inject_native_function(ctx, fs_obj, "existsSync", fs_exists_sync_cb)

		value := cast(jsc.JSValueRef)fs_obj
		module_cache_put(ctx, state, specifier, value)
		return value
	}

	resolved, resolved_ok := resolve_module_path(ctx, specifier)
	if !resolved_ok {
		// Node throws MODULE_NOT_FOUND rather than silently yielding undefined.
		if exception != nil {
			exception^ = make_js_error(ctx, fmt.tprintf("Cannot find module '%s'", specifier))
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer delete(resolved, context.allocator)

	if cached, ok := module_cache_get(state, resolved); ok {
		return cached
	}

	if strings.has_suffix(resolved, ".json") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		json_source := fmt.aprintf("(%s)", string(data), allocator = context.temp_allocator)
		value := eval_source_value(ctx, json_source, resolved, exception)
		if exception == nil || exception^ == nil {
			module_cache_put(ctx, state, resolved, value)
		}
		return value
	}

	if strings.has_suffix(resolved, ".mjs") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		wrapped, wrap_ok := esm_wrap_source(ctx, string(data), resolved, exception)
		if !wrap_ok do return jsc.JSValueMakeUndefined(ctx)
		defer delete(wrapped, context.allocator)

		value := eval_source_value(ctx, wrapped, resolved, exception)
		if exception == nil || exception^ == nil {
			module_cache_put(ctx, state, resolved, value)
		}
		return value
	}

	if strings.has_suffix(resolved, ".cjs") || strings.has_suffix(resolved, ".js") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE {
			if exception != nil {
				exception^ = make_js_error(ctx, fmt.tprintf("Cannot read module '%s'", resolved))
			}
			return jsc.JSValueMakeUndefined(ctx)
		}
		defer delete(data, context.allocator)

		dirname := filepath.dir(resolved)
		wrapper_parts := [?]string {
			"(function(){var module={exports:{},children:[]};var exports=module.exports;(function(exports,require,module,__filename,__dirname){\n",
			string(data),
			"\n})(exports,require,module,",
			js_quote(resolved),
			",",
			js_quote(dirname),
			");return module.exports;})()",
		}
		wrapped, wrapped_err := strings.concatenate(wrapper_parts[:], context.temp_allocator)
		if wrapped_err != nil do return jsc.JSValueMakeUndefined(ctx)
		value := eval_source_value(ctx, wrapped, resolved, exception)
		if exception == nil || exception^ == nil {
			module_cache_put(ctx, state, resolved, value)
		}
		return value
	}

	return jsc.JSValueMakeUndefined(ctx)
}

inject_native_function :: proc(
	ctx: jsc.JSContextRef,
	object: jsc.JSObjectRef,
	name: string,
	callback: jsc.JSObjectCallAsFunctionCallback,
) {
	c_name, err := strings.clone_to_cstring(name, context.temp_allocator)
	if err != nil do return

	js_name := jsc.JSStringCreateWithUTF8CString(c_name)
	defer jsc.JSStringRelease(js_name)

	fn := jsc.JSObjectMakeFunctionWithCallback(ctx, js_name, callback)
	jsc.JSObjectSetProperty(ctx, object, js_name, cast(jsc.JSValueRef)fn, {}, nil)
}

resolve_module_path :: proc(ctx: jsc.JSContextRef, specifier: string) -> (string, bool) {
	is_relative := strings.has_prefix(specifier, "./") || strings.has_prefix(specifier, "../")
	when ODIN_OS == .Windows {
		if strings.has_prefix(specifier, ".\\") || strings.has_prefix(specifier, "..\\") {
			is_relative = true
		}
	}
	if !(is_relative || is_absolute_path(specifier)) {
		return "", false
	}

	candidate: string
	if is_absolute_path(specifier) {
		candidate, _ = strings.clone(specifier, context.allocator)
	} else {
		base_dir := current_dirname(ctx)
		base_dir_allocated := len(base_dir) > 0
		defer if base_dir_allocated do delete(base_dir, context.allocator)
		if len(base_dir) == 0 {
			base_dir = "."
		}
		parts := [?]string{base_dir, specifier}
		joined, join_err := filepath.join(parts[:], context.temp_allocator)
		if join_err != nil do return "", false
		candidate, _ = filepath.abs(joined, context.allocator)
	}
	if len(candidate) == 0 do return "", false

	if module_file_exists(candidate) do return candidate, true

	extensions := [?]string{".js", ".cjs", ".mjs", ".json"}
	for ext in extensions {
		ext_parts := [?]string{candidate, ext}
		with_ext, with_ext_err := strings.concatenate(ext_parts[:], context.allocator)
		if with_ext_err != nil do continue
		if module_file_exists(with_ext) {
			delete(candidate, context.allocator)
			return with_ext, true
		}
		delete(with_ext, context.allocator)
	}

	delete(candidate, context.allocator)
	return "", false
}

module_file_exists :: proc(path: string) -> bool {
	return os.exists(path)
}

current_dirname :: proc(ctx: jsc.JSContextRef) -> string {
	global_obj := jsc.JSContextGetGlobalObject(ctx)
	key := jsc.JSStringCreateWithUTF8CString("__dirname")
	defer jsc.JSStringRelease(key)

	value := jsc.JSObjectGetProperty(ctx, global_obj, key, nil)
	result, allocated := jsc_value_to_string_or_default(ctx, value)
	if !allocated do return ""
	return result
}

eval_source_value :: proc(
	ctx: jsc.JSContextRef,
	source, source_name: string,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	script := js_string_from_string(source)
	if script == nil do return jsc.JSValueMakeUndefined(ctx)
	defer jsc.JSStringRelease(script)

	source_url := js_string_from_string(source_name)
	defer if source_url != nil do jsc.JSStringRelease(source_url)

	child_exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, script, nil, source_url, 1, &child_exception)
	if child_exception != nil && exception != nil {
		exception^ = child_exception
	}
	if value == nil do return jsc.JSValueMakeUndefined(ctx)
	return value
}

// esm_wrap_source rewrites an ES module `source` (resolved at `filename`) into a
// self-contained CommonJS expression by calling js/internal/esm.js. The returned
// string is allocated in context.allocator and must be freed by the caller. On
// failure it sets `exception` (when non-nil) and returns ("", false).
esm_wrap_source :: proc(
	ctx: jsc.JSContextRef,
	source, filename: string,
	exception: ^jsc.JSValueRef,
) -> (
	string,
	bool,
) {
	state := get_state_from_ctx(ctx)
	if state == nil || state.esm_transform == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "ESM transform unavailable")
		}
		return "", false
	}

	abs_path, abs_err := filepath.abs(filename, context.temp_allocator)
	if abs_err != os.ERROR_NONE {
		// Fall back to the path as given when abs resolution fails.
		abs_path = filename
	}
	dir := filepath.dir(abs_path)
	url := esm_file_url(abs_path)

	args := [4]jsc.JSValueRef {
		js_string_value(ctx, source),
		js_string_value(ctx, url),
		js_string_value(ctx, abs_path),
		js_string_value(ctx, dir),
	}
	call_exception: jsc.JSValueRef
	result := jsc.JSObjectCallAsFunction(
		ctx,
		cast(jsc.JSObjectRef)state.esm_transform,
		nil,
		4,
		raw_data(args[:]),
		&call_exception,
	)
	if call_exception != nil {
		if exception != nil do exception^ = call_exception
		return "", false
	}

	wrapped, allocated := jsc_value_to_string_or_default(ctx, result)
	if !allocated {
		if exception != nil {
			exception^ = make_js_error(ctx, "ESM transform produced no output")
		}
		return "", false
	}
	return wrapped, true
}

// esm_file_url builds the `file://` URL exposed to a module as import.meta.url.
esm_file_url :: proc(abs_path: string) -> string {
	when ODIN_OS == .Windows {
		slashed, _ := strings.replace_all(abs_path, "\\", "/", context.temp_allocator)
		parts := [?]string{"file:///", slashed}
		result, err := strings.concatenate(parts[:], context.temp_allocator)
		if err != nil do return abs_path
		return result
	} else {
		parts := [?]string{"file://", abs_path}
		result, err := strings.concatenate(parts[:], context.temp_allocator)
		if err != nil do return abs_path
		return result
	}
}

js_quote :: proc(value: string) -> string {
	parts := [?]string{"\"", value, "\""}
	result, err := strings.concatenate(parts[:], context.temp_allocator)
	if err != nil do return "\"\""
	return result
}

js_string_value :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)
	if err != nil do return jsc.JSValueMakeUndefined(ctx)

	js_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_str)

	return jsc.JSValueMakeString(ctx, js_str)
}

// is_absolute_path classifies module specifiers during resolution. (node:path's
// own isAbsolute lives in js/internal/path.js.)
is_absolute_path :: proc(path: string) -> bool {
	when ODIN_OS == .Windows {
		if len(path) == 0 do return false
		// Leading separator, including UNC paths (\\server\share) and '//'.
		if path[0] == '/' || path[0] == '\\' do return true
		// Drive-letter absolute path: 'C:\' or 'C:/'.
		if len(path) >= 3 &&
		   is_ascii_letter(path[0]) &&
		   path[1] == ':' &&
		   (path[2] == '/' || path[2] == '\\') {
			return true
		}
		return false
	} else {
		return strings.has_prefix(path, "/")
	}
}

is_ascii_letter :: proc(c: byte) -> bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

jsc_value_to_string_or_default :: proc(
	ctx: jsc.JSContextRef,
	value: jsc.JSValueRef,
) -> (
	string,
	bool,
) {
	js_string := jsc.JSValueToStringCopy(ctx, value, nil)
	if js_string == nil do return "", false
	defer jsc.JSStringRelease(js_string)

	max_size := int(jsc.JSStringGetMaximumUTF8CStringSize(js_string))
	if max_size <= 0 do return "", false

	// One allocation in the caller's allocator; callers free it with
	// context.allocator when the returned bool is true.
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
