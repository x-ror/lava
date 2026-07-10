package lava_runtime

import "base:runtime"
import "core:bytes"
import "core:c"
import "core:os"
import "core:strconv"
import "core:strings"
import "core:unicode/utf8"
import jsc "lava:pkg/jsc"

// Native codec backing for the node:buffer built-in. The hand-rolled JS
// encoders in js/internal/buffer.js (kept as a small-input fallback) are replaced
// on the hot paths by these Odin primitives, reached through the `native` bindings
// object the loader passes as the factory's fourth argument — same mechanism as
// crypto (see runtime-native-builtin-bindings). The JS layer owns Node's encoding
// quirks (lenient base64 normalization) and size-gates the FFI for tiny inputs.

// Codec lookup tables. The encoders write straight into a NUL-terminated temp
// buffer that goes to JSStringCreateWithUTF8CString (pure-ASCII output, so JSC
// builds an 8-bit StringImpl) — one write pass + one JSC pass, no intermediate
// clone. The decode tables map a byte to its value, 0xFF = not in the alphabet.
@(private = "file") HEX_DIGITS := "0123456789abcdef"
@(private = "file") B64_ALPHABET := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
@(private = "file") g_hex_val: [256]u8
@(private = "file") g_b64_val: [256]u8

@(init, private = "file")
buffer_codec_tables_init :: proc "contextless" () {
	for i in 0 ..< 256 {
		g_hex_val[i] = 0xFF
		g_b64_val[i] = 0xFF
	}
	for ch, v in "0123456789" do g_hex_val[ch] = u8(v)
	for ch, v in "abcdef" do g_hex_val[ch] = u8(v) + 10
	for ch, v in "ABCDEF" do g_hex_val[ch] = u8(v) + 10
	for ch, v in B64_ALPHABET do g_b64_val[ch] = u8(v)
}

// ascii_string_value builds a JS string from a NUL-terminated ASCII buffer that
// was allocated with exactly one spare byte for the terminator. Factored so every
// encoder returns through the same JSC path.
@(private = "file")
ascii_string_value :: proc(ctx: jsc.JSContextRef, buf: []byte) -> jsc.JSValueRef {
	js_str := jsc.JSStringCreateWithUTF8CString(cstring(raw_data(buf)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

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

	out := make([]byte, len(data) * 2 + 1, context.temp_allocator)
	for b, i in data {
		out[i * 2] = HEX_DIGITS[b >> 4]
		out[i * 2 + 1] = HEX_DIGITS[b & 0x0F]
	}
	out[len(data) * 2] = 0
	return ascii_string_value(ctx, out)
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

	// Read the string as UTF-16 code units in place (GetCharactersPtr) instead of
	// converting to a UTF-8 copy: hex input is ASCII, so each unit IS the char and
	// a unit >= 256 is simply not in the alphabet (the table covers 0..255).
	js_string := jsc.JSValueToStringCopy(ctx, arguments[0], nil)
	if js_string == nil do return make_uint8_array(ctx, nil)
	defer jsc.JSStringRelease(js_string)
	length := int(jsc.JSStringGetLength(js_string))
	if length < 2 do return make_uint8_array(ctx, nil)
	chars := jsc.JSStringGetCharactersPtr(js_string)
	if chars == nil do return make_uint8_array(ctx, nil)

	// Exact-capacity output owned by context.allocator: make_uint8_array hands the
	// backing store to JSC NoCopy and jsc_buffer_deallocator frees it on collection.
	out := make([]byte, length / 2, context.allocator)
	n := 0
	for i := 0; i + 1 < length; i += 2 {
		c0 := chars[i]
		c1 := chars[i + 1]
		if c0 >= 256 || c1 >= 256 do break
		hi := g_hex_val[c0]
		lo := g_hex_val[c1]
		if hi == 0xFF || lo == 0xFF do break
		out[n] = hi << 4 | lo
		n += 1
	}
	return make_uint8_array(ctx, out[:n])
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

	n := len(data)
	out := make([]byte, (n + 2) / 3 * 4 + 1, context.temp_allocator)
	di := 0
	i := 0
	for ; i + 2 < n; i += 3 {
		v := u32(data[i]) << 16 | u32(data[i + 1]) << 8 | u32(data[i + 2])
		out[di] = B64_ALPHABET[v >> 18]
		out[di + 1] = B64_ALPHABET[v >> 12 & 0x3F]
		out[di + 2] = B64_ALPHABET[v >> 6 & 0x3F]
		out[di + 3] = B64_ALPHABET[v & 0x3F]
		di += 4
	}
	switch n - i {
	case 1:
		v := u32(data[i]) << 16
		out[di] = B64_ALPHABET[v >> 18]
		out[di + 1] = B64_ALPHABET[v >> 12 & 0x3F]
		out[di + 2] = '='
		out[di + 3] = '='
		di += 4
	case 2:
		v := u32(data[i]) << 16 | u32(data[i + 1]) << 8
		out[di] = B64_ALPHABET[v >> 18]
		out[di + 1] = B64_ALPHABET[v >> 12 & 0x3F]
		out[di + 2] = B64_ALPHABET[v >> 6 & 0x3F]
		out[di + 3] = '='
		di += 4
	}
	out[di] = 0
	return ascii_string_value(ctx, out)
}

// base64Decode(string) -> Uint8Array. The JS layer normalizes the input
// (strips non-alphabet chars, fixes padding) so the string handed here is clean,
// padded standard base64; anything else yields an empty array, matching the old
// core:encoding/base64 error behavior.
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

	// Same in-place UTF-16 read as hexDecode: base64 input is ASCII by contract.
	js_string := jsc.JSValueToStringCopy(ctx, arguments[0], nil)
	if js_string == nil do return make_uint8_array(ctx, nil)
	defer jsc.JSStringRelease(js_string)
	length := int(jsc.JSStringGetLength(js_string))
	if length == 0 || length % 4 != 0 do return make_uint8_array(ctx, nil)
	chars := jsc.JSStringGetCharactersPtr(js_string)
	if chars == nil do return make_uint8_array(ctx, nil)

	groups := length / 4
	out := make([]byte, groups * 3, context.allocator)
	n := 0
	for g in 0 ..< groups {
		s := chars[g * 4:g * 4 + 4]
		if s[0] >= 256 || s[1] >= 256 || s[2] >= 256 || s[3] >= 256 {
			delete(out, context.allocator)
			return make_uint8_array(ctx, nil)
		}
		d0 := g_b64_val[s[0]]
		d1 := g_b64_val[s[1]]
		pad2 := s[2] == '='
		pad3 := s[3] == '='
		d2 := pad2 ? 0 : g_b64_val[s[2]]
		d3 := pad3 ? 0 : g_b64_val[s[3]]
		// Padding is only legal in the final group, and '=' before a non-'=' is
		// malformed ("x=y="); both fail closed like core:encoding/base64 did.
		if d0 == 0xFF || d1 == 0xFF || d2 == 0xFF || d3 == 0xFF ||
		   (pad2 && !pad3) || ((pad2 || pad3) && g != groups - 1) {
			delete(out, context.allocator)
			return make_uint8_array(ctx, nil)
		}
		v := u32(d0) << 18 | u32(d1) << 12 | u32(d2) << 6 | u32(d3)
		out[n] = byte(v >> 16)
		n += 1
		if !pad2 && !pad3 {
			out[n] = byte(v >> 8)
			out[n + 1] = byte(v)
			n += 2
		} else if !pad2 {
			out[n] = byte(v >> 8)
			n += 1
		}
	}
	return make_uint8_array(ctx, out[:n])
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

// decode_utf8_to_utf16_whatwg decodes a UTF-8 byte slice into UTF-16 code units written
// to `out`, implementing the WHATWG "UTF-8 decoder" / Unicode "U+FFFD
// substitution of maximal subparts" rule that Node (V8) follows. The key
// difference from a naive per-byte decode is the handling of an *invalid
// continuation* byte: the in-progress sequence emits a single U+FFFD and the
// offending byte is then re-processed as a potential new lead, so an ill-formed
// subsequence collapses to one replacement rather than one per byte. A naive
// per-byte decoder would instead emit one U+FFFD for each bad byte
// (Buffer.from([0xF0,0x9F]) -> "��", where Node yields "�").
// Embedded NULs are preserved. `out` must hold at least len(data)+1 units: every
// emitted unit is charged to >= 1 consumed input byte, and an astral scalar
// costs 2 units but 4 bytes, so the count never exceeds len(data) (+1 covers the
// trailing replacement for an unfinished sequence at end of input).
decode_utf8_to_utf16_whatwg :: proc "contextless" (data: []byte, out: []u16) -> (n: int) {
	i := 0
	// Fast path: copy the leading ASCII run verbatim. ASCII (and ASCII-heavy
	// mixed text) is the common case for Buffer.toString('utf8'); a byte <= 0x7F
	// decodes to itself, so we skip the state machine until the first non-ASCII
	// byte. The slow loop below has the same shortcut for ASCII that resumes after
	// a multi-byte sequence.
	for i < len(data) && data[i] <= 0x7F {
		out[n] = u16(data[i]); n += 1
		i += 1
	}

	code_point: u32 = 0
	bytes_needed := 0
	bytes_seen := 0
	lower: u8 = 0x80
	upper: u8 = 0xBF

	for i < len(data) {
		b := data[i]
		if bytes_needed == 0 {
			if b <= 0x7F { 	// ASCII resumes after a completed multi-byte sequence
				out[n] = u16(b); n += 1
				i += 1
				continue
			}
			switch {
			case b >= 0xC2 && b <= 0xDF:
				bytes_needed = 1; code_point = u32(b & 0x1F)
				i += 1
			case b >= 0xE0 && b <= 0xEF:
				if b == 0xE0 do lower = 0xA0 // exclude overlong < U+0800
				if b == 0xED do upper = 0x9F // exclude UTF-16 surrogates
				bytes_needed = 2; code_point = u32(b & 0x0F)
				i += 1
			case b >= 0xF0 && b <= 0xF4:
				if b == 0xF0 do lower = 0x90 // exclude overlong < U+10000
				if b == 0xF4 do upper = 0x8F // exclude > U+10FFFF
				bytes_needed = 3; code_point = u32(b & 0x07)
				i += 1
			case:
				// Invalid lead byte (0x80..0xC1, 0xF5..0xFF): one replacement.
				out[n] = 0xFFFD; n += 1
				i += 1
			}
		} else {
			if b < lower || b > upper {
				// Invalid continuation: flush a replacement for the bytes seen so
				// far, reset state, and re-process this byte (do not advance i).
				code_point = 0; bytes_needed = 0; bytes_seen = 0
				lower = 0x80; upper = 0xBF
				out[n] = 0xFFFD; n += 1
			} else {
				lower = 0x80; upper = 0xBF
				code_point = (code_point << 6) | u32(b & 0x3F)
				bytes_seen += 1
				i += 1
				if bytes_seen == bytes_needed {
					// #force_inline: hot path, but keep emit_utf16 a single named unit
					// (no duplicated surrogate-pair logic).
					n += #force_inline emit_utf16(out[n:], code_point)
					code_point = 0; bytes_needed = 0; bytes_seen = 0
				}
			}
		}
	}
	// Unfinished trailing sequence at end of input -> a single replacement.
	if bytes_needed != 0 {
		out[n] = 0xFFFD; n += 1
	}
	return n
}

// utf8Decode(u8) -> string. Decodes via the WHATWG UTF-8 decoder
// (decode_utf8_to_utf16_whatwg) and builds the JS string from the code units, because
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

	// Fast path: NUL-free input goes through JSC's own UTF-8 conversion
	// (JSStringCreateWithUTF8CString), which validates strictly and builds an
	// 8-bit StringImpl for ASCII — one JSC pass instead of our WHATWG decode into
	// a UTF-16 buffer plus a second copying create. Valid UTF-8 decodes
	// identically under both, so this only diverts inputs where the replacement
	// rule cannot fire. Invalid input comes back as an EMPTY string (that is the
	// documented C-API failure mode), which a non-empty input can never produce
	// legitimately — detected below and sent down the WHATWG path.
	if bytes.index_byte(data, 0) < 0 {
		tmp := make([]byte, len(data) + 1, context.temp_allocator)
		copy(tmp, data)
		tmp[len(data)] = 0
		js_str := jsc.JSStringCreateWithUTF8CString(cstring(raw_data(tmp)))
		if jsc.JSStringGetLength(js_str) > 0 {
			defer jsc.JSStringRelease(js_str)
			return jsc.JSValueMakeString(ctx, js_str)
		}
		jsc.JSStringRelease(js_str)
	}

	// +1 headroom for a trailing-replacement at end of input (see proc docs).
	units := make([]u16, len(data) + 1, context.temp_allocator)
	n := decode_utf8_to_utf16_whatwg(data, units)

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

// compare(a, b) -> -1 | 0 | 1. Native lexicographic byte comparison with the
// shorter-array-is-less tiebreak — the same total order as the JS compareBytes
// fallback, but a single native pass instead of a JS loop. The JS layer only
// routes here once at least one input is past a small size threshold (the FFI
// crossing costs more than a JS loop for tiny buffers). Both views are read in
// place; nothing is allocated.
buffer_compare_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeNumber(ctx, 0)
	a, aok := typed_array_view(ctx, arguments[0])
	b, bok := typed_array_view(ctx, arguments[1])
	if !aok || !bok do return jsc.JSValueMakeNumber(ctx, 0)
	n := min(len(a), len(b))
	for i in 0 ..< n {
		if a[i] < b[i] do return jsc.JSValueMakeNumber(ctx, -1)
		if a[i] > b[i] do return jsc.JSValueMakeNumber(ctx, 1)
	}
	if len(a) < len(b) do return jsc.JSValueMakeNumber(ctx, -1)
	if len(a) > len(b) do return jsc.JSValueMakeNumber(ctx, 1)
	return jsc.JSValueMakeNumber(ctx, 0)
}

// indexOf(haystack, needle, start, forward) -> absolute index | -1. Native byte
// search backing buf.indexOf / lastIndexOf / includes for large buffers, using
// core:bytes' Rabin-Karp instead of the JS O(n*m) double loop. The JS layer keeps
// Node's empty-needle and offset-clamping semantics and only calls here for a
// non-empty needle; `start` is the first index to consider (forward) or the
// highest index a match may start at (backward). Views are read in place.
buffer_index_of_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 do return jsc.JSValueMakeNumber(ctx, -1)
	hay, hok := typed_array_view(ctx, arguments[0])
	needle, nok := typed_array_view(ctx, arguments[1])
	if !hok || !nok do return jsc.JSValueMakeNumber(ctx, -1)
	nlen := len(needle)
	hlen := len(hay)
	if nlen == 0 || nlen > hlen do return jsc.JSValueMakeNumber(ctx, -1)
	start := int(jsc.JSValueToNumber(ctx, arguments[2], nil))
	forward := jsc.JSValueToBoolean(ctx, arguments[3])
	if forward {
		s := start
		if s < 0 do s = 0
		if s > hlen do return jsc.JSValueMakeNumber(ctx, -1)
		idx := bytes.index(hay[s:], needle)
		if idx < 0 do return jsc.JSValueMakeNumber(ctx, -1)
		return jsc.JSValueMakeNumber(ctx, f64(s + idx))
	}
	// Backward: search the window [0, start+nlen) so the last match within it
	// starts at the largest k <= start. bytes.last_index returns an absolute index
	// (the window begins at 0) or -1.
	end := start + nlen
	if end > hlen do end = hlen
	if end < nlen do return jsc.JSValueMakeNumber(ctx, -1)
	return jsc.JSValueMakeNumber(ctx, f64(bytes.last_index(hay[:end], needle)))
}

// isValidUtf8(bytes) -> bool. Strict UTF-8 validation (rejects overlong forms,
// surrogate-range code points, and truncated sequences) via core:unicode/utf8's
// allocation-free validator. Replaces the JS round-trip in buffer.isUtf8 (decode
// to a string, re-encode, compare) that TextDecoder fatal mode also leans on; the
// view is validated in place with no string or buffer allocation.
buffer_is_valid_utf8_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeBoolean(ctx, true)
	data, ok := typed_array_view(ctx, arguments[0])
	if !ok do return jsc.JSValueMakeBoolean(ctx, false)
	if len(data) == 0 do return jsc.JSValueMakeBoolean(ctx, true)
	return jsc.JSValueMakeBoolean(ctx, b32(utf8.valid_string(string(data))))
}

// latin1Encode(string) -> Uint8Array. One output byte per UTF-16 code unit,
// low 8 bits only — Node's Buffer.from(str, 'latin1') / 'ascii' (encode side).
// Reads units in place via GetCharactersPtr (no UTF-8 intermediate).
buffer_latin1_encode_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return make_uint8_array(ctx, nil)

	js_string := jsc.JSValueToStringCopy(ctx, arguments[0], nil)
	if js_string == nil do return make_uint8_array(ctx, nil)
	defer jsc.JSStringRelease(js_string)
	length := int(jsc.JSStringGetLength(js_string))
	if length == 0 do return make_uint8_array(ctx, nil)
	chars := jsc.JSStringGetCharactersPtr(js_string)
	if chars == nil do return make_uint8_array(ctx, nil)

	out := make([]byte, length, context.allocator)
	for i in 0 ..< length {
		out[i] = byte(chars[i] & 0xFF)
	}
	return make_uint8_array(ctx, out)
}

// latin1_string_from_bytes builds a JS string where each input byte becomes one
// UTF-16 unit (ISO-8859-1 / Node 'latin1'). Pure ASCII without NULs takes the
// dense 8-bit StringImpl path (UTF-8 create); anything with a high bit or NUL
// goes through CreateWithCharacters so bytes are preserved.
@(private = "file")
latin1_string_from_bytes :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	if len(data) == 0 do return js_string_value(ctx, "")
	ascii := true
	for b in data {
		if b == 0 || b >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		// NUL-free 0x01-0x7F: one write + JSStringCreateWithUTF8CString → LChar.
		tmp := make([]byte, len(data) + 1, context.temp_allocator)
		copy(tmp, data)
		tmp[len(data)] = 0
		return ascii_string_value(ctx, tmp)
	}
	units := make([]jsc.JSChar, len(data), context.temp_allocator)
	for i in 0 ..< len(data) do units[i] = jsc.JSChar(data[i])
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(len(data)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}

// latin1Decode(u8) -> string. Buffer.toString('latin1') / 'binary'.
buffer_latin1_decode_cb :: proc "c" (
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
	return latin1_string_from_bytes(ctx, data)
}

// asciiDecode(u8) -> string. Buffer.toString('ascii'): each byte masked to 7 bits.
// After the mask the alphabet is pure ASCII (possibly with NULs); reuse the
// latin1 builder so NUL/dense-ASCII paths stay correct.
buffer_ascii_decode_cb :: proc "c" (
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

	// Mask in a temp only when a high bit is present; otherwise latin1 path is
	// identical and avoids an extra pass + allocation.
	needs_mask := false
	for b in data {
		if b >= 0x80 {
			needs_mask = true
			break
		}
	}
	if !needs_mask do return latin1_string_from_bytes(ctx, data)

	masked := make([]byte, len(data), context.temp_allocator)
	for b, i in data do masked[i] = b & 0x7F
	return latin1_string_from_bytes(ctx, masked)
}

// utf8WriteInto(target, string, offset, maxLength) -> bytesWritten. Encodes the
// string to UTF-8 (JSC already produced those bytes when the value was read) and
// copies up to maxLength of them straight into the caller's Buffer at offset —
// eliminating the throwaway intermediate Uint8Array and the JS copy loop that
// Buffer.prototype.write previously paid on every utf8 write. Truncation matches
// the old strToBytes-then-copy path (a multibyte char may be cut at the
// maxLength / remaining-space boundary); the JS layer computes maxLength so the
// returned count equals the prior result.
buffer_utf8_write_into_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 do return jsc.JSValueMakeNumber(ctx, 0)
	target, tok := typed_array_view(ctx, arguments[0])
	if !tok do return jsc.JSValueMakeNumber(ctx, 0)
	str, alloc := jsc_value_to_string_or_default(ctx, arguments[1])
	defer if alloc do delete(str, context.allocator)
	offset := int(jsc.JSValueToNumber(ctx, arguments[2], nil))
	max := int(jsc.JSValueToNumber(ctx, arguments[3], nil))
	if offset < 0 do offset = 0
	if offset > len(target) do offset = len(target)
	avail := len(target) - offset
	n := len(str)
	if n > max do n = max
	if n > avail do n = avail
	if n <= 0 do return jsc.JSValueMakeNumber(ctx, 0)
	src := transmute([]byte)str
	copy(target[offset:offset + n], src[:n])
	return jsc.JSValueMakeNumber(ctx, f64(n))
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
	inject_native_function(ctx, bindings, "latin1Encode", buffer_latin1_encode_cb)
	inject_native_function(ctx, bindings, "latin1Decode", buffer_latin1_decode_cb)
	inject_native_function(ctx, bindings, "asciiDecode", buffer_ascii_decode_cb)
	inject_native_function(ctx, bindings, "allocUninit", buffer_alloc_uninit_cb)
	inject_native_function(ctx, bindings, "compare", buffer_compare_cb)
	inject_native_function(ctx, bindings, "indexOf", buffer_index_of_cb)
	inject_native_function(ctx, bindings, "isValidUtf8", buffer_is_valid_utf8_cb)
	inject_native_function(ctx, bindings, "utf8WriteInto", buffer_utf8_write_into_cb)
	// The practical allocation ceiling; buffer.js reads it as kMaxLength (the
	// Bun-parity 4 GiB) and enforces it on Buffer paths before `new Buffer(size)`
	// reaches JSC.
	set_named(ctx, bindings, "maxAllocBytes", jsc.JSValueMakeNumber(ctx, max_buffer_alloc_bytes()))
	return bindings
}
