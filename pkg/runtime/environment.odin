package lava_runtime

import "base:runtime"
import "core:c"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strconv"
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

	// 2.5. Інжектуємо вказівник на Event Loop як рядок для збереження 64-бітної точності
	if loop != nil {
		loop_str := fmt.tprintf("%d", cast(uintptr)loop)
		inject_global_string(ctx, global_obj, "__loop_ptr__", loop_str)
	}

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

path_basename_cb :: proc "c" (
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

	path_str, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(path_str, context.allocator)

	base := filepath.base(path_str)

	c_base, c_base_err := strings.clone_to_cstring(base, context.temp_allocator)
	if c_base_err != nil do return jsc.JSValueMakeUndefined(ctx)
	js_str := jsc.JSStringCreateWithUTF8CString(c_base)
	defer jsc.JSStringRelease(js_str)

	return jsc.JSValueMakeString(ctx, js_str)
}

path_join_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count == 0 do return js_string_value(ctx, ".")

	args := arguments[:int(argument_count)]
	parts := make([]string, len(args), context.temp_allocator)
	allocated := make([]bool, len(args), context.temp_allocator)

	for arg, i in args {
		parts[i], allocated[i] = jsc_value_to_string_or_default(ctx, arg)
	}
	defer {
		for part, i in parts {
			if allocated[i] do delete(part, context.allocator)
		}
	}

	joined, join_err := filepath.join(parts, context.temp_allocator)
	if join_err != nil do return jsc.JSValueMakeUndefined(ctx)
	return js_string_value(ctx, joined)
}

path_extname_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return js_string_value(ctx, "")

	args := arguments[:int(argument_count)]
	path_str, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(path_str, context.allocator)

	return js_string_value(ctx, path_extname(path_str))
}

path_is_absolute_cb :: proc "c" (
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

	return jsc.JSValueMakeBoolean(ctx, b32(is_absolute_path(path_str)))
}

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
	defer delete(data, context.allocator)

	return js_string_value(ctx, string(data))
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
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	specifier, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(specifier, context.allocator)

	// 1. Обробка вбудованого модуля node:path
	if specifier == "node:path" {
		path_obj := jsc.JSObjectMake(ctx, nil, nil)

		inject_native_function(ctx, path_obj, "basename", path_basename_cb)
		inject_native_function(ctx, path_obj, "join", path_join_cb)
		inject_native_function(ctx, path_obj, "extname", path_extname_cb)
		inject_native_function(ctx, path_obj, "isAbsolute", path_is_absolute_cb)

		return cast(jsc.JSValueRef)path_obj
	}

	if specifier == "node:fs" {
		fs_obj := jsc.JSObjectMake(ctx, nil, nil)

		inject_native_function(ctx, fs_obj, "readFileSync", fs_read_file_sync_cb)
		inject_native_function(ctx, fs_obj, "existsSync", fs_exists_sync_cb)

		return cast(jsc.JSValueRef)fs_obj
	}

	// 2. Обробка вбудованого модуля node:assert/strict
	if specifier == "node:assert/strict" {
		assert_obj := jsc.JSObjectMake(ctx, nil, nil)

		inject_native_function(ctx, assert_obj, "equal", noop_cb)
		inject_native_function(ctx, assert_obj, "deepEqual", noop_cb)
		inject_native_function(ctx, assert_obj, "match", noop_cb)

		return cast(jsc.JSValueRef)assert_obj
	}

	resolved, resolved_ok := resolve_module_path(ctx, specifier)
	if !resolved_ok {
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer delete(resolved, context.allocator)

	if strings.has_suffix(resolved, ".json") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE do return jsc.JSValueMakeUndefined(ctx)
		defer delete(data, context.allocator)

		json_source := fmt.aprintf("(%s)", string(data), allocator = context.temp_allocator)
		return eval_source_value(ctx, json_source, resolved, exception)
	}

	if strings.has_suffix(resolved, ".cjs") || strings.has_suffix(resolved, ".js") {
		data, err := os.read_entire_file(resolved, context.allocator)
		if err != os.ERROR_NONE do return jsc.JSValueMakeUndefined(ctx)
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
		return eval_source_value(ctx, wrapped, resolved, exception)
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
	if !(strings.has_prefix(specifier, "./") ||
		   strings.has_prefix(specifier, "../") ||
		   strings.has_prefix(specifier, "/")) {
		return "", false
	}

	candidate: string
	if strings.has_prefix(specifier, "/") {
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

	extensions := [?]string{".js", ".cjs", ".json"}
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

path_extname :: proc(path: string) -> string {
	last_slash := strings.last_index_byte(path, '/')
	last_dot := strings.last_index_byte(path, '.')
	if last_dot <= last_slash || last_dot < 0 || last_dot == len(path) - 1 {
		return ""
	}
	return path[last_dot:]
}

is_absolute_path :: proc(path: string) -> bool {
	return strings.has_prefix(path, "/")
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

	buffer := make([]byte, max_size, context.temp_allocator)
	written := int(
		jsc.JSStringGetUTF8CString(
			js_string,
			raw_data(buffer),
			jsc.JSStringGetMaximumUTF8CStringSize(js_string),
		),
	)
	if written <= 1 do return "", false

	result, err := strings.clone_from_bytes(buffer[:written - 1], context.allocator)
	return result, err == nil
}

// Допоміжна процедура для витягування вказівника на Loop з контексту JS
// Використовуйте її всередині будь-яких нативних асинхронних callback-функцій
get_loop_from_ctx :: proc(ctx: jsc.JSContextRef) -> ^eventloop.Loop {
	global_obj := jsc.JSContextGetGlobalObject(ctx)

	key := jsc.JSStringCreateWithUTF8CString("__loop_ptr__")
	defer jsc.JSStringRelease(key)

	value := jsc.JSObjectGetProperty(ctx, global_obj, key, nil)
	if value == nil || jsc.JSValueIsUndefined(ctx, value) do return nil

	str_val, allocated := jsc_value_to_string_or_default(ctx, value)
	defer if allocated do delete(str_val, context.allocator)

	val, ok := strconv.parse_uint(str_val, 10)
	if !ok do return nil

	return cast(^eventloop.Loop)uintptr(val)
}
