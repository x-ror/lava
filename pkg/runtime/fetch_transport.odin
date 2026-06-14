#+build linux, darwin, windows
package lava_runtime

import "core:net"
import "core:strings"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Shared fetch transport for the readiness-based backends (Linux epoll/io_uring,
// Darwin kqueue, Windows select). The connect→[TLS handshake]→write→read state
// machine and the DNS hand-off live here and are OpenSSL-free. Each platform
// supplies only the socket primitives (create/connect, send/recv, SO_ERROR check,
// watch-mode flip, close) in fetch_{linux,darwin,windows}.odin, plus a TLS backend
// (fetch_tls.odin = OpenSSL; fetch_tls_stub.odin = reject) that the https branches
// delegate to. Targets with no transport at all fall back to fetch_other.odin.

// Fetch_IO_Result is the outcome of a raw (plaintext) socket read/write, mapped
// by the platform primitives from the OS error so the state machine stays
// platform-agnostic. .Closed is read-only (recv saw EOF); send never returns it.
Fetch_IO_Result :: enum {
	Ok, // transferred n bytes
	Would_Block, // EAGAIN/EWOULDBLOCK — wait for the next readiness event
	Closed, // orderly peer close (recv returned 0)
	Failed, // a real socket error
}

// fetch_transport_start begins a request. An IPv6/IPv4 literal connects
// synchronously; a hostname is resolved on a background thread and the connect is
// deferred to fetch_dns_complete_cb (run back on the loop thread via post_async).
// Returns ok=false with a message only for an immediate failure; the async path
// returns ok=true and settles later.
fetch_transport_start :: proc(
	req: ^Fetch_Request,
	host: string,
	port: int,
) -> (
	ok: bool,
	err: string,
) {
	// Reject https:// up front on backends without TLS (fetch_tls_supported ==
	// false), before any DNS lookup or outbound connect — so an unsupported
	// request fails instantly and locally instead of after network work.
	if req.is_https && !fetch_tls_supported {
		return false, FETCH_HTTPS_UNSUPPORTED_MSG
	}

	// An IPv6 literal host (e.g. "::1") arrives bracket-stripped from
	// parse_http_url and is the only host that can contain a colon.
	if strings.index_byte(host, ':') >= 0 {
		ip6, ip_ok := net.parse_ip6_address(host)
		if !ip_ok do return false, "fetch: could not resolve host"
		return fetch_connect_ip6(req, ip6, port)
	}

	// An IPv4 literal needs no lookup — connect on the spot (no worker thread).
	if ip4, ip_ok := net.parse_ip4_address(host); ip_ok {
		return fetch_connect_ip4(req, transmute([4]u8)ip4, port)
	}

	// A hostname: resolve off the loop. async_begin keeps the loop alive while the
	// worker runs; the worker posts fetch_dns_complete_cb back to the loop thread.
	// It must precede the spawn (the worker may post before this returns), so on a
	// spawn failure we undo it — otherwise the loop would block forever on an
	// in-flight count that never clears, and the fetch would never settle.
	eventloop.async_begin(req.loop)
	worker := thread.create_and_start_with_data(req, fetch_dns_worker, nil, .Normal, true)
	if worker == nil {
		eventloop.async_cancel(req.loop)
		return false, "fetch: could not start DNS resolver thread"
	}
	return true, ""
}

// fetch_dns_worker runs on a background thread: it resolves the host (blocking
// getaddrinfo, off the loop), stashes the result on the request, and posts the
// continuation back to the loop. It must not touch the request after post_async.
fetch_dns_worker :: proc(data: rawptr) {
	req := cast(^Fetch_Request)data
	if ep, dns_err := net.resolve_ip4(req.host); dns_err == nil {
		if ip4, ip_ok := ep.address.(net.IP4_Address); ip_ok {
			req.dns_ip4 = transmute([4]u8)ip4
			req.dns_ok = true
		}
	}
	free_all(context.temp_allocator) // release this worker's resolver scratch
	eventloop.post_async(req.loop, fetch_dns_complete_cb, req)
}

// fetch_dns_complete_cb runs on the loop thread once DNS finishes: it connects to
// the resolved address (or rejects on failure). Reading req.dns_* here is safe —
// post_async published the worker's writes.
fetch_dns_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data
	if req == nil || req.settled do return
	if !req.dns_ok {
		fetch_settle_error(req, "fetch: could not resolve host")
		return
	}
	if connected, conn_err := fetch_connect_ip4(req, req.dns_ip4, req.port); !connected {
		fetch_settle_error(req, conn_err)
	}
}

// fetch_register_socket records the connecting socket on the request and watches
// it for writability (connect completion). Loop thread only. The fd is closed via
// the platform fetch_close_fd if the watch registration fails.
fetch_register_socket :: proc(req: ^Fetch_Request, fd: uintptr) -> (ok: bool, err: string) {
	req.fd = fd
	req.has_fd = true
	req.phase = .Connecting
	req.watcher = eventloop.IO_Watcher {
		fd        = fd,
		mode      = .Write, // writable == connect complete (or error via SO_ERROR)
		callback  = fetch_watcher_cb,
		user_data = req,
	}
	if !eventloop.watch_fd(req.loop, &req.watcher) {
		fetch_close_fd(fd)
		req.has_fd = false
		return false, "fetch: could not register socket with the event loop"
	}
	return true, ""
}

// fetch_watcher_cb advances the request whenever the socket is ready. Connect →
// (TLS handshake for https) → write the whole request → read until EOF, then
// settle. EAGAIN / WANT_* means "not ready, wait for the next event".
fetch_watcher_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data
	if req == nil || req.settled do return

	switch req.phase {
	case .Connecting:
		if !fetch_connect_succeeded(req) {
			fetch_settle_error(req, "fetch: connection failed")
			return
		}
		if req.is_https {
			// TLS is a platform-swappable backend (real OpenSSL on Linux/Darwin, a
			// reject stub where it is not yet wired up): set up the session and run
			// the first handshake step, settling on its own error if unsupported.
			fetch_tls_start_handshake(loop, req)
			return
		}
		req.phase = .Writing
		fetch_write(loop, req) // socket is writable now, try sending immediately

	case .TLS_Handshake:
		fetch_tls_handshake(loop, req)

	case .Writing:
		fetch_write(loop, req)

	case .Reading:
		fetch_read(loop, req)
	}
}

// fetch_write sends the request bytes over the plaintext socket. When the whole
// request is out it flips the watch to reading. https takes the parallel TLS path
// (fetch_tls_write) supplied by the platform TLS backend.
fetch_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.is_https {
		fetch_tls_write(loop, req)
		return
	}
	for req.write_offset < len(req.request_bytes) {
		chunk := req.request_bytes[req.write_offset:]
		n, res := fetch_raw_send(req, chunk)
		switch res {
		case .Ok:
		case .Would_Block:
			if !fetch_set_watch_mode(loop, req, .Write) {
				fetch_settle_error(req, "fetch: event loop watch failed")
			}
			return // wait for the next writable event
		case .Closed, .Failed:
			fetch_settle_error(req, "fetch: send failed")
			return
		}
		if n <= 0 do return
		req.write_offset += n
	}
	if !fetch_set_watch_mode(loop, req, .Read) {
		fetch_settle_error(req, "fetch: event loop watch failed")
		return
	}
	req.phase = .Reading // next readable event reads the response
}

// fetch_read drains the response from the plaintext socket until EOF, then
// settles. https takes the parallel TLS path (fetch_tls_read) supplied by the
// platform TLS backend.
fetch_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if req.is_https {
		fetch_tls_read(loop, req)
		return
	}
	buf: [16384]byte
	for {
		n, res := fetch_raw_recv(req, buf[:])
		switch res {
		case .Ok:
		case .Would_Block:
			if !fetch_set_watch_mode(loop, req, .Read) {
				fetch_settle_error(req, "fetch: event loop watch failed")
			}
			return // wait for more data
		case .Closed:
			fetch_settle_response(req) // EOF — server closed, response complete
			return
		case .Failed:
			fetch_settle_error(req, "fetch: receive failed")
			return
		}
		append(&req.response, ..buf[:n])
	}
}
