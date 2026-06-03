package lava_runtime

import "base:runtime"
import "core:c"
import "core:encoding/base64"
import "core:encoding/hex"
import "core:unicode/utf16"
import jsc "lava:pkg/jsc"

// Native codec backing for the node:buffer built-in. The hand-rolled JS
// encoders in js/internal/buffer.js (kept as a fallback) are replaced on the hot
// paths by these Odin primitives, reached through the `native` bindings object
// the loader passes as the factory's fourth argument — same mechanism as crypto
// (see runtime-native-builtin-bindings). The JS layer owns Node's encoding
// quirks (lenient base64 normalization, ascii/latin1); these do the bulk work.

// hexEncode(u8) -> string. Lowercase hex, matching Buffer.toString('hex').
buffer_hex_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return js_string_value(ctx, "")

	data, ok := typed_array_view(ctx, arguments[0])
	if !ok || len(data) == 0 do return js_string_value(ctx, "")

	encoded, err := hex.encode(data, context.temp_allocator)
	if err != nil do return js_string_value(ctx, "")
	return js_string_value(ctx, string(encoded))
}

// hexDecode(string) -> Uint8Array. Decodes byte pairs and stops at the first
// non-hex pair (or a dangling nibble), mirroring Node's Buffer.from(str, 'hex').
buffer_hex_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	str, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc do delete(str, context.allocator)

	out := make([dynamic]byte, 0, len(str) / 2, context.allocator)
	for i := 0; i + 1 < len(str); i += 2 {
		b, ok := hex.decode_sequence(str[i:i + 2])
		if !ok do break
		append(&out, b)
	}
	return make_uint8_array(ctx, out[:])
}

// base64Encode(u8) -> string. Standard alphabet with padding, matching
// Buffer.toString('base64').
buffer_base64_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return js_string_value(ctx, "")

	data, ok := typed_array_view(ctx, arguments[0])
	if !ok || len(data) == 0 do return js_string_value(ctx, "")

	encoded, err := base64.encode(data, base64.ENC_TABLE, context.temp_allocator)
	if err != nil do return js_string_value(ctx, "")
	return js_string_value(ctx, encoded)
}

// base64Decode(string) -> Uint8Array. The JS layer normalizes the input
// (strips non-alphabet chars, fixes padding) so the string handed here is clean,
// padded standard base64 — exactly what core:encoding/base64 expects.
buffer_base64_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	str, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc do delete(str, context.allocator)
	if len(str) == 0 do return make_uint8_array(ctx, nil)

	decoded, err := base64.decode(str, base64.DEC_TABLE, context.allocator)
	if err != nil do return make_uint8_array(ctx, nil)
	return make_uint8_array(ctx, decoded)
}

// utf8Encode(string) -> Uint8Array. JavaScriptCore already produced a UTF-8
// encoding of the JS string (surrogate handling included) when we read it, so we
// just hand those bytes straight to a typed array — ownership of the backing
// buffer transfers to JSC.
buffer_utf8_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	str, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	if !alloc do return make_uint8_array(ctx, nil) // empty string
	// Do NOT free `str`: its backing buffer is handed to JSC below.
	return make_uint8_array(ctx, transmute([]byte)str)
}

// utf8Decode(u8) -> string. We decode to UTF-16 ourselves (utf16.encode_string
// maps invalid UTF-8 to U+FFFD and preserves embedded NUL) and build the JS
// string from code units, because JSStringCreateWithUTF8CString would truncate
// at an embedded NUL — Node keeps it.
buffer_utf8_decode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return js_string_value(ctx, "")

	data, ok := typed_array_view(ctx, arguments[0])
	if !ok || len(data) == 0 do return js_string_value(ctx, "")

	// Each input byte yields at most one UTF-16 code unit, so len(data) is a
	// safe upper bound.
	units := make([]u16, len(data), context.temp_allocator)
	n := utf16.encode_string(units, string(data))

	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// make_buffer_bindings builds the `native` object handed to js/internal/buffer.js.
make_buffer_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "hexEncode", buffer_hex_encode_cb)
	inject_native_function(ctx, bindings, "hexDecode", buffer_hex_decode_cb)
	inject_native_function(ctx, bindings, "base64Encode", buffer_base64_encode_cb)
	inject_native_function(ctx, bindings, "base64Decode", buffer_base64_decode_cb)
	inject_native_function(ctx, bindings, "utf8Encode", buffer_utf8_encode_cb)
	inject_native_function(ctx, bindings, "utf8Decode", buffer_utf8_decode_cb)
	return bindings
}
