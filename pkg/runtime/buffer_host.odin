package lava_runtime

import "core:c"
import jsc "lava:pkg/jsc"

// Host-call-convention entry points for the node:buffer natives: dedicated
// wrappers (no dispatch-table lookup) around the shared host_dispatch in
// host_natives.odin, which documents the convention. Each is a distinct proc "c"
// so JSC's stored NativeFunction pointer identifies the codec directly, skipping
// the callee->callback map lookup the generic path (host_native_create) does per
// call. That lookup is NOT free on these hottest natives: measured +~25ns on
// Buffer.alloc(16).toString('hex') (110ns -> 135ns, ~20%), so the buffer codecs
// and the two hot node:http natives keep baked-in wrappers while every colder
// native (fs/os/crypto/dns/...) uses the generic path to avoid the boilerplate.

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
