package lava_runtime

import "core:c"
import jsc "lava:pkg/jsc"

// Host-call-convention entry points for the node:buffer natives. Each wrapper
// adapts JSC's internal calling convention (JSGlobalObject*, CallFrame*) to the
// existing C-API callback bodies: on 64-bit JSC a call-frame argument slot IS a
// JSValueRef bit pattern and JSContextRef IS the JSGlobalObject pointer (both
// facts are verified by jsc.host_function_create's probe before any of these
// can be reached), so the adaptation is just slicing arguments off the frame.
// Registering natives this way skips the C-API callback machinery — argument
// vector marshaling and, above all, the JSLock::DropAllLocks/re-lock mutex
// round trip that JSCallbackFunction pays on every single call.

@(private = "file")
host_dispatch :: proc "c" (
	global: rawptr,
	cf: [^]u64,
	cb: jsc.JSObjectCallAsFunctionCallback,
) -> i64 {
	ctx := jsc.JSContextRef(global)
	argc := int(u32(cf[jsc.CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)) - 1 // minus `this`
	if argc < 0 do argc = 0
	if argc > 8 do argc = 8 // largest native arity is 4
	args: [8]jsc.JSValueRef
	for i in 0 ..< argc {
		args[i] = jsc.JSValueRef(uintptr(cf[jsc.CALL_FRAME_FIRST_ARG_SLOT + i]))
	}
	exception: jsc.JSValueRef
	ret := cb(ctx, nil, nil, c.size_t(argc), &args[0], &exception)
	if ret == nil do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
	return transmute(i64)ret
}

buffer_hex_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_hex_encode_cb)
}
buffer_hex_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_hex_decode_cb)
}
buffer_base64_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_base64_encode_cb)
}
buffer_base64_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_base64_decode_cb)
}
buffer_base64url_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_base64url_encode_cb)
}
buffer_utf8_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf8_encode_cb)
}
buffer_utf8_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf8_decode_cb)
}
buffer_latin1_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_latin1_encode_cb)
}
buffer_latin1_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_latin1_decode_cb)
}
buffer_ascii_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_ascii_decode_cb)
}
buffer_latin1_write_into_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_latin1_write_into_cb)
}
buffer_utf16le_encode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf16le_encode_cb)
}
buffer_utf16le_decode_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf16le_decode_cb)
}
buffer_utf16le_write_into_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf16le_write_into_cb)
}
buffer_utf8_byte_length_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf8_byte_length_cb)
}
buffer_base64_byte_length_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_base64_byte_length_cb)
}
buffer_swap_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_swap_cb)
}
buffer_alloc_uninit_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_alloc_uninit_cb)
}
buffer_compare_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_compare_cb)
}
buffer_index_of_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_index_of_cb)
}
buffer_is_valid_utf8_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_is_valid_utf8_cb)
}
buffer_utf8_write_into_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf8_write_into_cb)
}
