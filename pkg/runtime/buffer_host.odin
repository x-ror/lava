package lava_runtime

import "core:c"
import jsc "lava:pkg/jsc"

// Host-call entry points for the *measured* hottest node:buffer natives only.
// Each is a distinct proc "c" so JSC's stored NativeFunction identifies the
// codec without a callee→callback map lookup. Measured +~25ns on tiny hex
// (110→135ns with the generic path). Colder natives (compare, indexOf, swap,
// byteLength, allocUninit, isValidUtf8) register via host_native_create only.

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
buffer_utf8_write_into_host :: proc "c" (g: rawptr, cf: [^]u64) -> i64 {
	return host_dispatch(g, cf, buffer_utf8_write_into_cb)
}
