package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import jsc "lava:pkg/jsc"
import pico "lava:pkg/runtime/picohttpparser"

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
		set_named(ctx, result, "state", js_string_value(ctx, "error"))
		return cast(jsc.JSValueRef)result
	}
	args := arguments[:int(argument_count)]
	view, ok := typed_array_view(ctx, args[0])
	if !ok {
		set_named(ctx, result, "state", js_string_value(ctx, "error"))
		return cast(jsc.JSValueRef)result
	}
	last_len := int(jsc.JSValueToNumber(ctx, args[1], nil))

	hdrs: [pico.MAX_HEADERS]pico.Header
	consumed, minor, num, method, path, res := pico.parse_request(view, last_len, hdrs[:])
	if res == .Partial {
		set_named(ctx, result, "state", js_string_value(ctx, "partial"))
		return cast(jsc.JSValueRef)result
	}
	if res == .Error {
		set_named(ctx, result, "state", js_string_value(ctx, "error"))
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
	n := len(hdr_list)
	header_vals := make([]jsc.JSValueRef, n, context.temp_allocator)
	for i in 0 ..< n do header_vals[i] = http_latin1_string(ctx, hdr_list[i])
	headers_arr := jsc.JSObjectMakeArray(ctx, c.size_t(n), n > 0 ? raw_data(header_vals) : nil, nil)

	set_named(ctx, result, "state", js_string_value(ctx, "complete"))
	set_named(ctx, result, "consumed", jsc.JSValueMakeNumber(ctx, f64(consumed)))
	set_named(ctx, result, "method", http_latin1_string(ctx, method))
	set_named(ctx, result, "url", http_latin1_string(ctx, path))
	set_named(ctx, result, "minor", jsc.JSValueMakeNumber(ctx, f64(minor)))
	set_named(ctx, result, "headers", cast(jsc.JSValueRef)headers_arr)
	return cast(jsc.JSValueRef)result
}

// http_latin1_string builds a JS string by mapping each input BYTE to one UTF-16 code
// unit (latin1 / ISO-8859-1), matching how Node decodes HTTP/1 request bytes — preserving
// raw 0x80-0xFF obs-text instead of mis-interpreting it as UTF-8.
http_latin1_string :: proc(ctx: jsc.JSContextRef, value: string) -> jsc.JSValueRef {
	if len(value) == 0 do return js_string_value(ctx, "")
	units := make([]jsc.JSChar, len(value), context.temp_allocator)
	for i in 0 ..< len(value) do units[i] = jsc.JSChar(value[i])
	js_str := jsc.JSStringCreateWithCharacters(raw_data(units), c.size_t(len(value)))
	defer jsc.JSStringRelease(js_str)
	return jsc.JSValueMakeString(ctx, js_str)
}
