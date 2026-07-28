package lava_runtime

import "core:c"
import jsc "lava:pkg/jsc"

// Host-call entry points for the *measured* hottest node:buffer natives only.
// Each is a distinct proc "c" so JSC's stored NativeFunction identifies the
// codec without a callee→callback map lookup. Measured +~25ns on tiny hex
// (110→135ns with the generic path). Colder natives (compare, indexOf, swap,
// byteLength, allocUninit, isValidUtf8) register via host_native_create only.
//
// MOVING A NATIVE OUT OF THIS FILE IS A SECURITY CHANGE, not just a perf one.
// The three *_write_into wrappers below back buffer.js's fromString, which calls
// `allocate()` — a slice of the allocUnsafe pool, plain malloc, so it can hold a
// freed request body or key — and then DISCARDS the write-through's result. That
// is safe here only because a baked-in callback cannot miss: these entry points
// never consult the callee→callback registry. Demote one to the generic
// host_native_create path and the same call site becomes a fail-open that returns
// uninitialized pool memory as if it were the decoded string. The generic path's
// dispatcher fails closed for exactly this reason (host_natives.odin), which is
// what makes the demotion survivable — but "survivable" is a throw, not a silent
// correct answer, so measure before moving anything either way.

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
