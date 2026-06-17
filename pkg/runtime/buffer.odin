package lava_runtime

import "base:runtime"
import "core:c"
import "core:encoding/base64"
import "core:encoding/hex"
import "core:os"
import "core:strconv"
import "core:strings"
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

	decoded, err := base64.decode(str, base64.DEC_TABLE)
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

// emit_utf16 appends a Unicode scalar value to `out` as 1 (BMP) or 2 (surrogate
// pair) UTF-16 code units and returns how many it wrote.
emit_utf16 :: proc "contextless" (out: []u16, cp: u32) -> int {
	if cp <= 0xFFFF {
		out[0] = u16(cp)
		return 1
	}
	c := cp - 0x10000
	out[0] = u16(0xD800 + (c >> 10))
	out[1] = u16(0xDC00 + (c & 0x3FF))
	return 2
}

// decode_utf8_to_utf16 decodes a UTF-8 byte slice into UTF-16 code units written
// to `out`, implementing the WHATWG "UTF-8 decoder" / Unicode "U+FFFD
// substitution of maximal subparts" rule that Node (V8) follows. The key
// difference from a naive per-byte decode is the handling of an *invalid
// continuation* byte: the in-progress sequence emits a single U+FFFD and the
// offending byte is then re-processed as a potential new lead, so an ill-formed
// subsequence collapses to one replacement rather than one per byte. (Per-byte
// replacement is what the previous utf16.encode_string-over-string path did,
// e.g. Buffer.from([0xF0,0x9F]) -> "��" instead of Node's "�".)
// Embedded NULs are preserved. `out` must hold at least len(data)+1 units: every
// emitted unit is charged to >= 1 consumed input byte, and an astral scalar
// costs 2 units but 4 bytes, so the count never exceeds len(data) (+1 covers the
// trailing replacement for an unfinished sequence at end of input).
decode_utf8_to_utf16 :: proc "contextless" (data: []byte, out: []u16) -> (n: int) {
	code_point: u32 = 0
	bytes_needed := 0
	bytes_seen := 0
	lower: u8 = 0x80
	upper: u8 = 0xBF

	i := 0
	for i < len(data) {
		b := data[i]
		if bytes_needed == 0 {
			switch {
			case b <= 0x7F:
				out[n] = u16(b);n += 1
				i += 1
			case b >= 0xC2 && b <= 0xDF:
				bytes_needed = 1;code_point = u32(b & 0x1F)
				i += 1
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 do lower = 0xA0 // exclude overlong < U+0800
				if b == 0xED do upper = 0x9F // exclude UTF-16 surrogates
				bytes_needed = 2;code_point = u32(b & 0x0F)
				i += 1
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 do lower = 0x90 // exclude overlong < U+10000
				if b == 0xF4 do upper = 0x8F // exclude > U+10FFFF
				bytes_needed = 3;code_point = u32(b & 0x07)
				i += 1
			case:
				// Invalid lead byte (0x80..0xC1, 0xF5..0xFF): one replacement.
				out[n] = 0xFFFD;n += 1
				i += 1
			}
		} else {
			if b < lower || b > upper {
				// Invalid continuation: flush a replacement for the bytes seen so
				// far, reset state, and re-process this byte (do not advance i).
				code_point = 0;bytes_needed = 0;bytes_seen = 0
				lower = 0x80;upper = 0xBF
				out[n] = 0xFFFD;n += 1
			} else {
				lower = 0x80;upper = 0xBF
				code_point = (code_point << 6) | u32(b & 0x3F)
				bytes_seen += 1
				i += 1
				if bytes_seen == bytes_needed {
					n += emit_utf16(out[n:], code_point)
					code_point = 0;bytes_needed = 0;bytes_seen = 0
				}
			}
		}
	}
	// Unfinished trailing sequence at end of input -> a single replacement.
	if bytes_needed != 0 {
		out[n] = 0xFFFD;n += 1
	}
	return n
}

// utf8Decode(u8) -> string. Decodes via the WHATWG UTF-8 decoder
// (decode_utf8_to_utf16) and builds the JS string from the code units, because
// JSStringCreateWithUTF8CString would truncate at an embedded NUL — Node keeps
// it. Going through code units (rather than a UTF-8 C string) also lets us apply
// the maximal-subpart replacement rule that Buffer.toString('utf8') / TextDecoder
// require.
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

	// +1 headroom for a trailing-replacement at end of input (see proc docs).
	units := make([]u16, len(data) + 1, context.temp_allocator)
	n := decode_utf8_to_utf16(data, units)

	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(n))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// allocUninit(size) -> Uint8Array | null. Hands back `size` bytes of native,
// *uninitialized* memory (Node's allocUnsafe semantics) as a NoCopy Uint8Array
// that the JS layer wraps as a Buffer view. Only the unpooled unsafe paths reach
// here (large Buffer.allocUnsafe, Buffer.allocUnsafeSlow, SlowBuffer); the small
// pooled path stays in JS. Returns null for a non-positive size or an allocation
// failure, so the JS layer falls back to a zero-filled own-backing Buffer (which
// throws for an impossible size, matching Node). The size is already validated by
// assertSize on the JS side; the int() truncation here mirrors Node's allocator
// flooring a fractional request.
buffer_alloc_uninit_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNull(ctx)

	n := int(jsc.JSValueToNumber(ctx, arguments[0], nil))
	array, ok := make_uint8_array_uninit(ctx, n)
	if !ok do return jsc.JSValueMakeNull(ctx)
	return array
}

// DEFAULT_MAX_BUFFER_BYTES is the practical ceiling for a single Buffer / typed
// array allocation when LAVA_MAX_BUFFER_BYTES is unset. Unlike V8 — which throws a
// catchable RangeError when an in-range allocation cannot be satisfied —
// JavaScriptCore aborts the process once a request exceeds what it can allocate.
// The Buffer layer refuses anything past this ceiling with a catchable RangeError
// before JSC ever sees it (raw typed arrays rely on JSC's own throw). 4 GiB on 64-bit
// matches the JSC/Bun array-buffer ceiling; 2 GiB-1 on 32-bit is the addressable
// signed limit. Allocations within the cap that still exhaust RAM remain a
// documented JSC-vs-V8 difference (see reference/node-compatibility.md).
when size_of(uintptr) >= 8 {
	DEFAULT_MAX_BUFFER_BYTES :: 4294967296.0
} else {
	DEFAULT_MAX_BUFFER_BYTES :: 2147483647.0
}

// max_buffer_alloc_bytes resolves the allocation ceiling, honoring an optional
// LAVA_MAX_BUFFER_BYTES override — for operators who want a tighter bound. A
// malformed, negative, or zero value falls back to the platform default: a
// non-positive ceiling is treated as "unset" here so it matches the JS layer
// (buffer.js ignores a non-positive maxAllocBytes and falls back), rather than
// silently capping every allocation to zero.
max_buffer_alloc_bytes :: proc() -> f64 {
	environ, err := os.environ(context.temp_allocator)
	if err == os.ERROR_NONE {
		for entry in environ {
			idx := strings.index_byte(entry, '=')
			if idx <= 0 do continue
			if entry[:idx] != "LAVA_MAX_BUFFER_BYTES" do continue
			if n, ok := strconv.parse_f64(entry[idx + 1:]); ok && n > 0 {
				return n
			}
			break
		}
	}
	return DEFAULT_MAX_BUFFER_BYTES
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
	inject_native_function(ctx, bindings, "allocUninit", buffer_alloc_uninit_cb)
	// The practical allocation ceiling; buffer.js reads it as kMaxLength (the
	// Bun-parity 4 GiB) and enforces it on Buffer paths before `new Buffer(size)`
	// reaches JSC.
	set_named(ctx, bindings, "maxAllocBytes", jsc.JSValueMakeNumber(ctx, max_buffer_alloc_bytes()))
	return bindings
}
