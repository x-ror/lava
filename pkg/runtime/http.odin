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
	// Response-head serialization: same latin1WriteInto as node:buffer (package-local
	// callback). Avoids a Buffer require + intermediate array on every writeHead/end.
	inject_native_function(ctx, bindings, "latin1WriteInto", buffer_latin1_write_into_cb)
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
	// merged into the previous value with a single space. Header NAMES are ASCII-lowered
	// here so JS buildHeaders can skip String#toLowerCase on every key (Node's
	// req.headers keys are lowercased). Names are tokens (RFC 7230) so ASCII fold is
	// correct; values stay raw latin1. Lowercasing MUST copy — name/value slices alias
	// the request buffer.
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
		append(&hdr_list, http_ascii_lower(h.name))
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
			// Reuse the buffer codec's dense-ASCII / high-byte latin1 string path.
			latin1_string_from_bytes(ctx, transmute([]byte)hdr_list[i]),
			nil,
		)
	}

	set_named_ref(ctx, result, g_str_state, jsc.JSValueMakeString(ctx, g_str_complete))
	set_named_ref(ctx, result, g_str_consumed, jsc.JSValueMakeNumber(ctx, f64(consumed)))
	set_named_ref(ctx, result, g_str_method, latin1_string_from_bytes(ctx, transmute([]byte)method))
	set_named_ref(ctx, result, g_str_url, latin1_string_from_bytes(ctx, transmute([]byte)path))
	set_named_ref(ctx, result, g_str_minor, jsc.JSValueMakeNumber(ctx, f64(minor)))
	set_named_ref(ctx, result, g_str_headers, cast(jsc.JSValueRef)headers_arr)
	return cast(jsc.JSValueRef)result
}

// http_ascii_lower returns an ASCII-lowercased copy of `s` (A-Z → a-z only). HTTP header
// field-names are tokens; this matches Node's req.headers key fold without a JS pass.
@(private = "file")
http_ascii_lower :: proc(s: string) -> string {
	if len(s) == 0 do return s
	// Fast path: already lower (common for proxies that normalize).
	needs := false
	for i in 0 ..< len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			needs = true
			break
		}
	}
	if !needs do return s
	out := make([]byte, len(s), context.temp_allocator)
	for i in 0 ..< len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' do out[i] = c + 32
		else do out[i] = c
	}
	return string(out)
}
