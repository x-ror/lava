package lava_runtime

import "base:runtime"
import "core:c"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:unicode/utf16"
import "core:unicode/utf8"
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

	// Internal bridge the CommonJS wrapper calls to register an in-progress
	// module's exports before its body runs (see native_require_cb), so a
	// circular require resolves to the partial exports instead of recursing.
	inject_native_function(ctx, global_obj, "__lava_precache", module_precache_cb)

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
	exports_name := jsc.JSStringCreateWithUTF8CString("exports")
	defer jsc.JSStringRelease(module_name)
	defer jsc.JSStringRelease(children_name)
	defer jsc.JSStringRelease(exports_name)

	// Виправлено: додано касти до JSValueRef для властивостей об'єкта
	jsc.JSObjectSetProperty(
		ctx,
		module_obj,
		children_name,
		cast(jsc.JSValueRef)children_arr,
		{},
		nil,
	)

	// Initialize module.exports = {} (and the `exports` alias) so the entry can do
	// `module.exports.foo = …` / `exports.foo = …` without first reassigning
	// module.exports, matching Node's CommonJS entry — the per-module wrapper does
	// the same for required modules. Without this, `module.exports` is undefined on
	// the entry and the partial-exports cache (register_entry_module) has nothing
	// to register.
	exports_obj := jsc.JSObjectMake(ctx, nil, nil)
	jsc.JSObjectSetProperty(
		ctx,
		module_obj,
		exports_name,
		cast(jsc.JSValueRef)exports_obj,
		{},
		nil,
	)

	jsc.JSObjectSetProperty(ctx, global_obj, module_name, cast(jsc.JSValueRef)module_obj, {}, nil)
	jsc.JSObjectSetProperty(
		ctx,
		global_obj,
		exports_name,
		cast(jsc.JSValueRef)exports_obj,
		{},
		nil,
	)
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


// resolve_module_path resolves a `specifier` to a real file path, modeling Node's

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

// js_quote renders `value` as a double-quoted JS/JSON string literal, escaping
// every character that would otherwise change the literal's meaning. The CJS
// module wrapper splices resolved paths (__filename, __dirname, the precache key,
// the require base) through this, so unescaped input would corrupt or break the
// generated source: a Windows drive path's backslashes ("C:\utils") read as
// string escapes (an invalid \u → SyntaxError for the whole module), and a path
// component containing a quote or newline (legal on POSIX) terminates the literal
// early and injects into the module text. Equivalent to JSON.stringify of a
// string (which is what esm.js uses for the same job).
js_quote :: proc(value: string) -> string {
	b := strings.builder_make(context.temp_allocator)
	strings.write_byte(&b, '"')
	for i := 0; i < len(value); i += 1 {
		c := value[i]
		switch c {
		case '"':
			strings.write_string(&b, "\\\"")
		case '\\':
			strings.write_string(&b, "\\\\")
		case '\b':
			strings.write_string(&b, "\\b")
		case '\f':
			strings.write_string(&b, "\\f")
		case '\n':
			strings.write_string(&b, "\\n")
		case '\r':
			strings.write_string(&b, "\\r")
		case '\t':
			strings.write_string(&b, "\\t")
		case:
			if c < 0x20 {
				// Other control characters as \u00XX (JSON requires escaping these).
				strings.write_string(&b, "\\u00")
				hex := "0123456789abcdef"
				strings.write_byte(&b, hex[(c >> 4) & 0xf])
				strings.write_byte(&b, hex[c & 0xf])
			} else {
				// Pass bytes >= 0x20 through verbatim (UTF-8 stays intact).
				strings.write_byte(&b, c)
			}
		}
	}
	strings.write_byte(&b, '"')
	return strings.to_string(b)
}

// register_entry_module caches the entry module's exports under its resolved
// absolute path, so a module that require()s the entry by path gets the same
// instance instead of re-executing the entry's top level (and an entry-involved
// require cycle terminates). The .mjs entry registers itself via __lava_precache
// in its transformed body; this covers the CommonJS/script entry, whose body runs
// raw against the global `module`. Call it before evaluating the entry (so a cycle
// sees the partial exports, like Node) and again after (the body may reassign
// module.exports).
register_entry_module :: proc(ctx: jsc.JSContextRef, state: ^Runtime_State, source_name: string) {
	if state == nil do return
	abs_path, abs_err := filepath.abs(source_name, context.temp_allocator)
	if abs_err != os.ERROR_NONE || len(abs_path) == 0 do return

	global_obj := jsc.JSContextGetGlobalObject(ctx)
	mod_name := jsc.JSStringCreateWithUTF8CString("module")
	defer jsc.JSStringRelease(mod_name)
	mod_val := jsc.JSObjectGetProperty(ctx, global_obj, mod_name, nil)
	if !jsc.JSValueIsObject(ctx, mod_val) do return

	exp_name := jsc.JSStringCreateWithUTF8CString("exports")
	defer jsc.JSStringRelease(exp_name)
	exports := jsc.JSObjectGetProperty(ctx, cast(jsc.JSObjectRef)mod_val, exp_name, nil)
	if exports == nil do return

	module_cache_set(ctx, state, abs_path, exports)
}

js_string_value :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	c_value, err := strings.clone_to_cstring(value, context.temp_allocator)
	if err != nil do return jsc.JSValueMakeUndefined(ctx)

	js_str := jsc.JSStringCreateWithUTF8CString(c_value)
	defer jsc.JSStringRelease(js_str)

	return jsc.JSValueMakeString(ctx, js_str)
}

// js_string_from_bytes builds a JS string from raw UTF-8 bytes that may contain
// embedded NULs, by converting to UTF-16 and passing an explicit length. Unlike
// js_string_value (which routes through a NUL-terminated cstring and so truncates
// at the first 0x00), this preserves the full content — needed for SQLite TEXT,
// where a NUL is a legal byte.
js_string_from_bytes :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	if len(value) == 0 do return js_string_value(ctx, "")
	runes := utf8.string_to_runes(value, context.temp_allocator)
	// Each rune is at most two UTF-16 code units (a surrogate pair).
	units := make([]u16, len(runes) * 2, context.temp_allocator)
	n := utf16.encode(units, runes)
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
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
