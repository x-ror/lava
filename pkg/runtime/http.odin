package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import "core:sync"
import jsc "lava:pkg/jsc"
import pico "lava:pkg/runtime/picohttpparser"

// The parseRequest result object's property NAMES and the three state VALUES are constant. Their
// JSStringRefs are created ONCE (process-wide; a JSStringRef is immutable and context-group-independent,
// so it is safe to share read-only across the per-worker VMs) and reused — instead of allocating and
// releasing ~9 JSStrings per request. Initialized via http_intern_strings (sync.Once) at binding setup.
@(private = "file") g_http_str_once: sync.Once
@(private = "file") g_str_state, g_str_consumed, g_str_method, g_str_url, g_str_minor, g_str_headers: jsc.JSStringRef
@(private = "file") g_str_complete, g_str_partial, g_str_error: jsc.JSStringRef

@(private = "file")
http_intern_strings :: proc() {
	sync.once_do(&g_http_str_once, proc() {
		g_str_state = jsc.JSStringCreateWithUTF8CString("state")
		g_str_consumed = jsc.JSStringCreateWithUTF8CString("consumed")
		g_str_method = jsc.JSStringCreateWithUTF8CString("method")
		g_str_url = jsc.JSStringCreateWithUTF8CString("url")
		g_str_minor = jsc.JSStringCreateWithUTF8CString("minor")
		g_str_headers = jsc.JSStringCreateWithUTF8CString("headers")
		g_str_complete = jsc.JSStringCreateWithUTF8CString("complete")
		g_str_partial = jsc.JSStringCreateWithUTF8CString("partial")
		g_str_error = jsc.JSStringCreateWithUTF8CString("error")
	})
}

// set_named_ref sets a property using a pre-interned name JSStringRef (vs set_named, which creates the
// name string each call). Loop thread; the cached refs are immutable and never released.
@(private = "file")
set_named_ref :: proc(ctx: jsc.JSContextRef, obj: jsc.JSObjectRef, name: jsc.JSStringRef, value: jsc.JSValueRef) {
	jsc.JSObjectSetProperty(ctx, obj, name, value, {}, nil)
}

// node:http server support — the request-HEAD parser bridge. The protocol surface
// (Server, IncomingMessage, ServerResponse) lives in js/internal/http.js on top of
// node:net; this exposes one native primitive, parseRequest(buf, lastLen), that runs
// picohttpparser (phr_parse_request) over the accumulated request bytes and returns a
// plain object:
//   { state: "partial" }                                  — need more bytes
//   { state: "error" }                                    — malformed head
//   { state: "complete", consumed, method, url, minor,
//     headers: [name, value, ...] }                       — head parsed
// `consumed` is the head length (the body offset). All strings are copied into JS here,
// so nothing aliases the input buffer past this call. This binding is platform-agnostic
// (pure parsing); the server itself needs node:net, which is Linux-first.

make_http_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	http_intern_strings() // create the constant result-object JSStringRefs once (idempotent across workers)
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "parseRequest", http_parse_request_cb)
	return bindings
}

// http_parse_request_cb(buf: Uint8Array, lastLen: number) -> result object (see above).
http_parse_request_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	result := jsc.JSObjectMake(ctx, nil, nil)
	if argument_count < 2 {
		set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_error))
		return cast(jsc.JSValueRef)result
	}
	args := arguments[:int(argument_count)]
	view, ok := typed_array_view(ctx, args[0])
	if !ok {
		set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_error))
		return cast(jsc.JSValueRef)result
	}
	last_len := int(jsc.JSValueToNumber(ctx, args[1], nil))

	hdrs: [pico.MAX_HEADERS]pico.Header
	consumed, minor, num, method, path, res := pico.parse_request(view, last_len, hdrs[:])
	if res == .Partial {
		set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_partial))
		return cast(jsc.JSValueRef)result
	}
	if res == .Error {
		set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_error))
		return cast(jsc.JSValueRef)result
	}

	// Interleaved [name, value, ...]; RFC 7230 obs-fold continuations (empty name) are
	// merged into the previous value with a single space.
	hdr_list := make([dynamic]string, 0, num * 2, context.temp_allocator)
	last_val_idx := -1
	for i in 0 ..< num {
		h := hdrs[i]
		if h.name == "" {
			if last_val_idx >= 0 {
				cont := strings.trim_space(h.value)
				hdr_list[last_val_idx] = strings.concatenate(
					{hdr_list[last_val_idx], " ", cont},
					context.temp_allocator,
				)
			}
			continue
		}
		append(&hdr_list, h.name)
		append(&hdr_list, strings.trim_space(h.value))
		last_val_idx = len(hdr_list) - 1
	}

	// Build the headers array (and method/url) as LATIN-1 strings: HTTP/1 header bytes are
	// binary (obs-text 0x80-0xFF), and Node exposes them as latin1. Routing through the
	// UTF-8 helpers would mis-decode/corrupt non-ASCII bytes.
	//
	// Set each string into the array as it is created, rather than parking N freshly-made
	// JSValueRefs in an Odin temp_allocator slice and passing them to JSObjectMakeArray in
	// one shot. That slice lives in Odin heap memory, which JSC's conservative GC does NOT
	// scan (it scans only the machine stack + registers), so every header string in it was
	// an unrooted GC cell; a collection triggered while building the next string (certain
	// under load, deterministic under JSC_collectContinuously) frees them, and the array
	// build then reads freed cells — heap corruption that surfaces as a SIGABRT in JSC's GC
	// marker (MarkedBlock::aboutToMarkSlow). Setting into the array immediately keeps each
	// value rooted (by the array, or on the C stack in-flight), with only one live at a time.
	n := len(hdr_list)
	headers_arr := jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	for i in 0 ..< n {
		jsc.JSObjectSetPropertyAtIndex(
			ctx,
			headers_arr,
			c.uint(i),
			http_latin1_string(ctx, hdr_list[i]),
			nil,
		)
	}

	set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_complete))
	set_named_ref(ctx, result, g_str_consumed, jsc.JSValueMakeNumber(ctx, f64(consumed)))
	set_named_ref(ctx, result, g_str_method, http_latin1_string(ctx, method))
	set_named_ref(ctx, result, g_str_url, http_latin1_string(ctx, path))
	set_named_ref(ctx, result, g_str_minor, jsc.JSValueMakeNumber(ctx, f64(minor)))
	set_named_ref(ctx, result, g_str_headers, cast(jsc.JSValueRef)headers_arr)
	return cast(jsc.JSValueRef)result
}

// http_latin1_string builds a JS string from HTTP/1 header bytes (latin1 / ISO-8859-1), matching how Node
// exposes them. Two paths:
//   - ASCII (every byte 0x01-0x7F — the overwhelming common case): take the UTF-8 path, which yields a
//     DENSE 8-bit (LChar) StringImpl. JSStringCreateWithCharacters always builds a 2-byte/char (16-bit)
//     StringImpl even for pure ASCII — wasting half the backing bytes (and a widening temp); ASCII is
//     byte-identical under UTF-8, so this is JS-observably the same string at half the memory/bandwidth.
//   - obs-text present (any byte 0x80-0xFF, or a NUL): map each byte to one UTF-16 unit. UTF-8 decoding
//     would mis-interpret 0x80-0xFF (and truncate at a NUL), corrupting the raw bytes we must preserve.
http_latin1_string :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	if len(value) == 0 do return js_string_value(ctx, "")
	ascii := true
	for i in 0 ..< len(value) {
		if value[i] == 0 || value[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii do return js_string_value(ctx, value) // 8-bit StringImpl via the UTF-8 path
	units := make([]jsc.JSChar, len(value), context.temp_allocator)
	for i in 0 ..< len(value) do units[i] = jsc.JSChar(value[i])
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(len(value)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}
