package lava_runtime

import "base:runtime"
import "core:c"
import "core:strconv"
import "core:strings"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// Native backing for the WHATWG `fetch`. The JavaScript surface (Headers /
// Request / Response / Body) lives in js/internal/fetch.js; this file provides
// the single `native.request` primitive it calls, plus the HTTP/1.1 request
// serialization and response parsing. The actual non-blocking socket transport
// is platform code (fetch_linux.odin / fetch_other.odin) so this file stays
// OS-agnostic.
//
// The promise is created in JS — fetch.js wraps native.request in `new
// Promise(...)` and passes the success/failure callbacks in — so the native
// side needs no JSObjectMakeDeferredPromise binding; it simply invokes one of
// those two callbacks exactly once when the request settles.
//
// Scope: http:// and https:// (TLS via system OpenSSL on Linux; see
// tls_linux.odin), blocking DNS off the loop; the transport runs non-blocking on
// the event loop. See ROADMAP.

Fetch_Phase :: enum {
	Connecting,
	TLS_Handshake, // https only: drive SSL_connect between Connecting and Writing
	Writing,
	Reading,
}

// Fetch_Request owns everything an in-flight request needs. It outlives the
// native call that created it: the JS callbacks are GC-protected and the struct
// is heap-allocated, settled later from an event-loop I/O callback. Freeing is
// deferred to runtime teardown (see fetch_request_finish) because the io_uring
// watcher may reference it once more after we stop it.
Fetch_Request :: struct {
	ctx:           jsc.JSContextRef,
	loop:          ^eventloop.Loop,
	on_response:   jsc.JSObjectRef, // GC-protected JS callback(resultObject)
	on_error:      jsc.JSObjectRef, // GC-protected JS callback(messageString)
	cancel_fn:     jsc.JSObjectRef, // GC-protected cancel handle returned to JS
	settled:       bool,

	// Owned copies (the JSC-derived strings they came from do not outlive the call).
	url:           string,
	host:          string,
	path:          string,
	method:        string,
	port:          int,
	request_bytes: []byte,
	write_offset:  int,

	// Async DNS result, written by the resolver worker thread and read by the loop
	// after post_async publishes it (see fetch_linux.odin). IPv4-only for now.
	dns_ip4:       [4]u8,
	dns_ok:        bool,

	response:      [dynamic]byte,

	watcher:       eventloop.IO_Watcher,
	fd:            uintptr,
	has_fd:        bool,
	phase:         Fetch_Phase,

	// TLS state for https:// requests. is_https gates the TLS path in the
	// transport; tls is an opaque ^SSL (rawptr so this cross-platform struct
	// stays free of the OpenSSL binding), set at handshake start and released by
	// fetch_tls_cleanup in fetch_request_finish.
	is_https:      bool,
	tls:           rawptr,
}

// fetch_cancel_class is a JSClass whose instances carry a ^Fetch_Request as
// private data and are callable — calling them tears down the in-flight request
// without invoking any JS callback (the JS side rejects the promise itself).
// Created once and reused across all fetch calls on a given thread.
@(private = "file")
g_fetch_cancel_class: jsc.JSClassRef

fetch_get_cancel_class :: proc() -> jsc.JSClassRef {
	if g_fetch_cancel_class == nil {
		def := jsc.JSClassDefinition {
			class_name        = "FetchCancel",
			call_as_function  = fetch_cancel_fn_cb,
		}
		g_fetch_cancel_class = jsc.JSClassCreate(&def)
	}
	return g_fetch_cancel_class
}

// fetch_cancel_fn_cb tears down the request without invoking any JS callback.
// The JS caller rejects the promise with signal.reason after calling this.
fetch_cancel_fn_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	req := cast(^Fetch_Request)jsc.JSObjectGetPrivate(function)
	if req != nil && !req.settled {
		fetch_request_finish(req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// make_fetch_bindings builds the `native` object handed to js/internal/fetch.js.
make_fetch_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "request", fetch_request_cb)
	return bindings
}

// request(method, url, headerLines, body, onResponse, onError) — start an HTTP
// request. headerLines is a pre-serialized "Name: Value\r\n" block from the JS
// Headers object; body is a Uint8Array or null/undefined. The two callbacks are
// the resolve/reject sides of the JS promise. Returns undefined; the request
// settles later via one of the callbacks.
fetch_request_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 6 do return jsc.JSValueMakeUndefined(ctx)

	on_response := callback_arg(ctx, arguments[4])
	on_error := callback_arg(ctx, arguments[5])
	if on_response == nil || on_error == nil do return jsc.JSValueMakeUndefined(ctx)

	method, method_alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if method_alloc do delete(method, context.allocator)
	url, url_alloc := jsc_value_to_string_or_default(ctx, arguments[1])
	defer if url_alloc do delete(url, context.allocator)
	header_lines, header_alloc := jsc_value_to_string_or_default(ctx, arguments[2])
	defer if header_alloc do delete(header_lines, context.allocator)

	host, port, path, scheme, ok := parse_http_url(url)
	if !ok {
		fetch_reject_now(ctx, on_error, "fetch: invalid URL")
		return jsc.JSValueMakeUndefined(ctx)
	}
	if scheme != "http" && scheme != "https" {
		fetch_reject_now(ctx, on_error, "fetch: unsupported URL scheme")
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop := get_loop_from_ctx(ctx)
	if loop == nil {
		fetch_reject_now(ctx, on_error, "fetch: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	// Reclaim any prior settled requests now that we are safely past the loop
	// iterations that settled them.
	if state := get_state_from_ctx(ctx); state != nil do fetch_reclaim_pending(state)

	body: []byte
	if view, has_body := typed_array_view(ctx, arguments[3]); has_body do body = view

	req := new(Fetch_Request)
	req.ctx = ctx
	req.loop = loop
	req.on_response = on_response
	req.on_error = on_error
	req.method = strings.clone(method)
	req.url = strings.clone(url)
	req.host = strings.clone(host)
	req.path = strings.clone(path)
	req.port = port // needed by the deferred connect after async DNS resolves
	req.is_https = scheme == "https"
	// Serialize while the JSC-borrowed `body`/`header_lines` are still valid; the
	// resulting buffer is independent of them.
	req.request_bytes = build_http_request(req.method, req.host, port, req.path, header_lines, body, req.is_https)

	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)on_response)
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)on_error)

	// Build and GC-protect the cancel handle before starting the transport so
	// the JS caller can cancel even if the request settles synchronously.
	cancel_fn := jsc.JSObjectMake(ctx, fetch_get_cancel_class(), req)
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)cancel_fn)
	req.cancel_fn = cancel_fn

	started, err := fetch_transport_start(req, host, port)
	if !started {
		fetch_settle_error(req, err)
	}
	return cast(jsc.JSValueRef)cancel_fn
}

// parse_http_url splits an absolute http(s) URL into host, port, path, scheme.
// An IPv6 literal host ([::1]) is returned bracket-stripped (host == "::1");
// build_http_request re-brackets it for the Host header and the Linux transport
// connects over AF_INET6.
parse_http_url :: proc(url: string) -> (host: string, port: int, path: string, scheme: string, ok: bool) {
	rest := url
	switch {
	case strings.has_prefix(rest, "http://"):
		scheme = "http"
		rest = rest[7:]
	case strings.has_prefix(rest, "https://"):
		scheme = "https"
		rest = rest[8:]
	case:
		return "", 0, "", "", false
	}

	// The authority ends at the first '/', '?' or '#'; everything from there is
	// the request target. A query that sits directly after the authority
	// (http://host?x=1) must still produce an origin-form "/?x=1", and the
	// fragment ('#...') is never sent on the wire — build_http_request supplies
	// the leading '/'.
	authority := rest
	path = "/"
	auth_end := len(rest)
	for i in 0 ..< len(rest) {
		c := rest[i]
		if c == '/' || c == '?' || c == '#' {
			auth_end = i
			break
		}
	}
	if auth_end < len(rest) {
		authority = rest[:auth_end]
		target := rest[auth_end:]
		if hash := strings.index_byte(target, '#'); hash >= 0 do target = target[:hash]
		path = target if len(target) > 0 else "/"
	}
	// Drop any userinfo (user:pass@host).
	if at := strings.last_index_byte(authority, '@'); at >= 0 {
		authority = authority[at + 1:]
	}

	host = authority
	port = 443 if scheme == "https" else 80
	if len(authority) > 0 && authority[0] == '[' {
		// IPv6 literal (RFC 3986 §3.2.2): the address itself contains colons, so
		// the host is the bytes inside the brackets and a ":port" suffix can only
		// follow the closing ']'. Strip the brackets here — the connect path wants
		// the bare address; build_http_request re-wraps it for the Host header.
		rb := strings.index_byte(authority, ']')
		if rb < 0 do return "", 0, "", "", false
		host = authority[1:rb]
		rest_after := authority[rb + 1:]
		if len(rest_after) > 1 && rest_after[0] == ':' {
			if p, p_ok := strconv.parse_int(rest_after[1:]); p_ok do port = p
		}
	} else if colon := strings.last_index_byte(authority, ':'); colon >= 0 {
		host = authority[:colon]
		if p, p_ok := strconv.parse_int(authority[colon + 1:]); p_ok do port = p
	}
	if len(host) == 0 do return "", 0, "", "", false

	ok = true
	return
}

// build_http_request serializes the request line, a Host header, the caller's
// header block, Connection: close (so the server frames the body by closing —
// we then read to EOF), an optional Content-Length, and the body. The returned
// buffer is allocated on context.allocator and owned by the request.
build_http_request :: proc(
	method, host: string,
	port: int,
	path, header_lines: string,
	body: []byte,
	is_https: bool,
) -> []byte {
	b := strings.builder_make(context.allocator)
	strings.write_string(&b, method)
	strings.write_byte(&b, ' ')
	// Origin-form request target always begins with '/': a query-only path
	// ("?x=1", from http://host?x=1) gets the slash prepended here.
	if len(path) == 0 || path[0] != '/' do strings.write_byte(&b, '/')
	strings.write_string(&b, path)
	strings.write_string(&b, " HTTP/1.1\r\n")

	strings.write_string(&b, "Host: ")
	// An IPv6 literal host arrives bracket-stripped (it is the only host that can
	// contain a colon); RFC 7230 §5.4 requires the Host header to re-wrap it in [].
	host_is_ip6 := strings.index_byte(host, ':') >= 0
	if host_is_ip6 do strings.write_byte(&b, '[')
	strings.write_string(&b, host)
	if host_is_ip6 do strings.write_byte(&b, ']')
	// Omit the port when it is the scheme's default (Node sends `Host: host`, not
	// `host:80` / `host:443`, when the default port was implicit in the URL).
	default_port := is_https ? 443 : 80
	if port != default_port {
		strings.write_byte(&b, ':')
		strings.write_int(&b, port)
	}
	strings.write_string(&b, "\r\n")

	strings.write_string(&b, header_lines) // each line already ends with \r\n
	strings.write_string(&b, "Connection: close\r\n")

	if len(body) > 0 {
		strings.write_string(&b, "Content-Length: ")
		strings.write_int(&b, len(body))
		strings.write_string(&b, "\r\n")
	}
	strings.write_string(&b, "\r\n")
	if len(body) > 0 do strings.write_bytes(&b, body)

	return b.buf[:]
}

// fetch_settle_response parses the accumulated bytes and invokes on_response
// with { status, statusText, headers: [k0,v0,...], body: Uint8Array }.
fetch_settle_response :: proc(req: ^Fetch_Request) {
	if req.settled do return

	status, status_text, headers, body, ok := parse_http_response(req.response[:])
	if !ok {
		fetch_settle_error(req, "fetch: malformed HTTP response")
		return
	}

	result := jsc.JSObjectMake(req.ctx, nil, nil)
	set_named(req.ctx, result, "status", jsc.JSValueMakeNumber(req.ctx, f64(status)))
	set_named(req.ctx, result, "statusText", js_string_value(req.ctx, status_text))
	set_named(req.ctx, result, "headers", cast(jsc.JSValueRef)build_string_array(req.ctx, headers))
	// make_uint8_array hands `body` (context.allocator) to JSC no-copy; JSC frees it.
	set_named(req.ctx, result, "body", make_uint8_array(req.ctx, body))

	arg := cast(jsc.JSValueRef)result
	exception: jsc.JSValueRef
	// Callback BEFORE finish: a chained fetch() inside the callback calls
	// async_begin before this token is dropped (count stays ≥1, never 0).
	// Swapping these lines would cause a premature-idle exit and a use-after-free
	// (fetch_request_finish nulls watcher.callback, which the caller reads on return).
	invoke_user_callback(req.ctx, req.on_response, &arg, 1, &exception)
	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}
	fetch_request_finish(req)
}

// fetch_settle_error invokes on_error(message); fetch.js turns it into a
// rejected promise.
fetch_settle_error :: proc(req: ^Fetch_Request, message: string) {
	if req.settled {
		fetch_request_finish(req)
		return
	}
	arg := js_string_value(req.ctx, message)
	exception: jsc.JSValueRef
	// Callback BEFORE finish — same ordering invariant as fetch_settle_response.
	invoke_user_callback(req.ctx, req.on_error, &arg, 1, &exception)
	if exception != nil {
		report_uncaught(req.ctx, exception)
		mark_async_failed(req.ctx)
	}
	fetch_request_finish(req)
}

// fetch_reject_now rejects before a Fetch_Request exists (bad URL, no loop).
fetch_reject_now :: proc(ctx: jsc.JSContextRef, on_error: jsc.JSObjectRef, message: string) {
	arg := js_string_value(ctx, message)
	exception: jsc.JSValueRef
	jsc.JSObjectCallAsFunction(ctx, on_error, nil, 1, &arg, &exception)
}

// fetch_request_finish tears down a settled request: stop the watcher, close the
// socket, release the GC-protected callbacks. The struct is queued onto
// pending_free rather than freed here — the io_uring drain reads this watcher
// once more (to decide re-arm) right after the callback returns, so freeing now
// would be a use-after-free. It is reclaimed on the next request or at teardown,
// both safely past that read.
fetch_request_finish :: proc(req: ^Fetch_Request) {
	if req.settled do return
	req.settled = true

	// Clearing the callback stops the io_uring drain from re-arming this watcher
	// with live work; the epoll path is removed outright by unwatch_fd.
	req.watcher.callback = nil
	// Free the TLS session (if any) before closing the fd it was bound to.
	fetch_tls_cleanup(req)
	if req.has_fd {
		eventloop.unwatch_fd(req.loop, &req.watcher)
		fetch_close_fd(req.fd)
		req.has_fd = false
	}

	if req.on_response != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.on_response)
		req.on_response = nil
	}
	if req.on_error != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.on_error)
		req.on_error = nil
	}
	if req.cancel_fn != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.cancel_fn)
		req.cancel_fn = nil
	}

	if state := get_state_from_ctx(req.ctx); state != nil {
		append(&state.pending_free, req)
	}
}

// fetch_reclaim_pending frees every settled request awaiting cleanup. Safe to
// call any time after the settling loop iteration: a settled request has its
// watcher callback cleared and no poll in flight, so no later completion can
// reference it. Called at the start of each new request so retention stays
// bounded to roughly the in-flight set rather than growing until teardown.
fetch_reclaim_pending :: proc(state: ^Runtime_State) {
	for req in state.pending_free {
		delete(req.method)
		delete(req.url)
		delete(req.host)
		delete(req.path)
		if req.request_bytes != nil do delete(req.request_bytes)
		delete(req.response)
		free(req)
	}
	clear(&state.pending_free)
}

// fetch_destroy_pending reclaims and releases the backing store at teardown.
fetch_destroy_pending :: proc(state: ^Runtime_State) {
	fetch_reclaim_pending(state)
	delete(state.pending_free)
}

// parse_http_response splits a raw HTTP/1.1 response into status, status text,
// an interleaved [name, value, ...] header list, and the decoded body (chunked
// transfer-encoding is de-chunked; otherwise Content-Length bounds it, falling
// back to "everything until EOF"). The body is a fresh context.allocator slice
// ready to hand to JSC.
parse_http_response :: proc(
	data: []byte,
) -> (status: int, status_text: string, headers: []string, body: []byte, ok: bool) {
	sep := -1
	if len(data) >= 4 {
		for i in 0 ..= len(data) - 4 {
			if data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n' {
				sep = i
				break
			}
		}
	}
	if sep < 0 do return 0, "", nil, nil, false

	head := string(data[:sep])
	body_raw := data[sep + 4:]

	lines := strings.split(head, "\r\n", context.temp_allocator)
	if len(lines) == 0 do return 0, "", nil, nil, false

	// Status line: HTTP/1.1 200 OK
	status_line := lines[0]
	sp1 := strings.index_byte(status_line, ' ')
	if sp1 < 0 do return 0, "", nil, nil, false
	after := status_line[sp1 + 1:]
	code_str := after
	if sp2 := strings.index_byte(after, ' '); sp2 >= 0 {
		code_str = after[:sp2]
		status_text = after[sp2 + 1:]
	}
	code, code_ok := strconv.parse_int(code_str)
	if !code_ok do return 0, "", nil, nil, false
	status = code

	hdr_list := make([dynamic]string, 0, context.temp_allocator)
	is_chunked := false
	content_length := -1
	for i in 1 ..< len(lines) {
		line := lines[i]
		if len(line) == 0 do continue
		colon := strings.index_byte(line, ':')
		if colon < 0 do continue
		name := strings.trim_space(line[:colon])
		value := strings.trim_space(line[colon + 1:])
		append(&hdr_list, name)
		append(&hdr_list, value)

		lname := strings.to_lower(name, context.temp_allocator)
		switch lname {
		case "transfer-encoding":
			lvalue := strings.to_lower(value, context.temp_allocator)
			if strings.contains(lvalue, "chunked") do is_chunked = true
		case "content-length":
			if cl, cl_ok := strconv.parse_int(value); cl_ok do content_length = cl
		}
	}
	headers = hdr_list[:]

	switch {
	case is_chunked:
		decoded, dok := dechunk_body(body_raw)
		if !dok {
			// Truncated/malformed chunked stream (e.g. the connection dropped
			// mid-chunk). Reject rather than resolving with partial bytes; Node
			// surfaces this as TypeError: terminated.
			return 0, "", nil, nil, false
		}
		body = decoded
	case content_length >= 0:
		// A declared Content-Length longer than what arrived means the connection
		// closed mid-body; surface that as an error rather than a truncated success.
		if len(body_raw) < content_length do return 0, "", nil, nil, false
		body = make([]byte, content_length, context.allocator)
		copy(body, body_raw[:content_length])
	case:
		body = make([]byte, len(body_raw), context.allocator)
		copy(body, body_raw)
	}

	ok = true
	return
}

// dechunk_body decodes a chunked transfer-encoding body into a flat slice on
// context.allocator. ok is true only when the terminating zero-length chunk is
// reached; a missing size line, an unparsable size, a chunk that runs past the
// buffer, or running out of data before the final chunk all mean the stream was
// truncated/malformed — we free the partial buffer and return ok=false so the
// caller can reject instead of resolving with partial bytes.
dechunk_body :: proc(data: []byte) -> (body: []byte, ok: bool) {
	out := make([dynamic]byte, 0, len(data), context.allocator)
	i := 0
	for i < len(data) {
		line_end := -1
		for j := i; j + 1 < len(data); j += 1 {
			if data[j] == '\r' && data[j + 1] == '\n' {
				line_end = j
				break
			}
		}
		if line_end < 0 {
			delete(out)
			return nil, false
		}

		size_str := string(data[i:line_end])
		if semi := strings.index_byte(size_str, ';'); semi >= 0 do size_str = size_str[:semi]
		size, size_ok := strconv.parse_int(strings.trim_space(size_str), 16)
		if !size_ok {
			delete(out)
			return nil, false
		}

		i = line_end + 2
		if size == 0 do return out[:], true // final chunk: a clean end of stream
		if i + size > len(data) {
			delete(out)
			return nil, false
		}
		append(&out, ..data[i:i + size])
		i += size
		// Chunk data is always terminated by CRLF (RFC 7230); its absence means
		// the stream was cut short, so reject rather than accept partial data.
		if i + 1 >= len(data) || data[i] != '\r' || data[i + 1] != '\n' {
			delete(out)
			return nil, false
		}
		i += 2
	}
	// Ran out of input without ever seeing the zero-length terminator.
	delete(out)
	return nil, false
}
