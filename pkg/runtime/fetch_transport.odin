#+build linux, darwin
package lava_runtime

import "core:c"
import "core:net"
import "core:strings"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Shared fetch transport for the readiness-based backends (Linux epoll/io_uring,
// Darwin kqueue). The connect→[TLS handshake]→write→read state machine, the DNS
// hand-off, and the OpenSSL plumbing live here; each platform supplies only the
// socket primitives (create/connect, send/recv, SO_ERROR check, watch-mode flip,
// close) in fetch_linux.odin / fetch_darwin.odin. Non-Linux/Darwin targets get
// the rejecting stub in fetch_other.odin instead of this file.

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

// fetch_tls_cleanup frees the per-request SSL session. Called from
// fetch_request_finish before the underlying fd is closed (SSL_free does not
// close the fd). Safe to call when no TLS session was created.
fetch_tls_cleanup :: proc(req: ^Fetch_Request) {
	if req.tls != nil {
		SSL_free(cast(SSL)req.tls)
		req.tls = nil
	}
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
			ssl := tls_new_client(req.fd, req.host)
			if ssl == nil {
				fetch_settle_error(req, "fetch: TLS setup failed")
				return
			}
			req.tls = rawptr(ssl)
			req.phase = .TLS_Handshake
			fetch_tls_handshake(loop, req) // try the handshake immediately
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

// Fetch_TLS_Outcome classifies a non-positive SSL_connect/SSL_read/SSL_write result.
Fetch_TLS_Outcome :: enum {
	Pending, // OpenSSL wants more I/O; the watcher has been re-armed
	Eof, // the peer closed (clean close_notify, or an EOF without one)
	Fatal, // a real TLS or socket error
}

// fetch_tls_classify maps an SSL op's SSL_get_error onto a Fetch_TLS_Outcome,
// re-arming the loop watcher for WANT_READ/WANT_WRITE. ZERO_RETURN is a clean
// close_notify; SSL_ERROR_SYSCALL with ret == 0 is an EOF without one (common
// for HTTP/1.1 Connection: close), while ret < 0 is a genuine syscall failure
// and stays Fatal so truncation is not silently treated as completion.
fetch_tls_classify :: proc(
	loop: ^eventloop.Loop,
	req: ^Fetch_Request,
	ret: c.int,
) -> Fetch_TLS_Outcome {
	switch SSL_get_error(cast(SSL)req.tls, ret) {
	case SSL_ERROR_WANT_READ:
		// A failed re-arm becomes Fatal so the caller settles instead of stalling.
		return fetch_set_watch_mode(loop, req, .Read) ? .Pending : .Fatal
	case SSL_ERROR_WANT_WRITE:
		return fetch_set_watch_mode(loop, req, .Write) ? .Pending : .Fatal
	case SSL_ERROR_ZERO_RETURN:
		return .Eof
	case SSL_ERROR_SYSCALL:
		return ret == 0 ? .Eof : .Fatal
	case:
		return .Fatal
	}
}

// fetch_tls_handshake drives the non-blocking SSL_connect. On completion it
// advances to Writing and attempts the first send; otherwise it re-arms the
// watcher for the direction OpenSSL is waiting on and returns. Certificate and
// hostname verification are enforced by the context (SSL_VERIFY_PEER) and
// SSL_set1_host, so a bad/mismatched cert surfaces here as a handshake failure.
// An EOF mid-handshake is fatal — there is no response to complete yet.
fetch_tls_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	ret := SSL_connect(cast(SSL)req.tls)
	if ret == 1 {
		req.phase = .Writing
		fetch_write(loop, req)
		return
	}
	if fetch_tls_classify(loop, req, ret) != .Pending {
		fetch_settle_error(req, "fetch: TLS handshake failed")
	}
}

// fetch_write sends the request bytes — as TLS records for https, raw socket
// writes for http. When the whole request is out it flips the watch to reading.
fetch_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	for req.write_offset < len(req.request_bytes) {
		chunk := req.request_bytes[req.write_offset:]
		if req.is_https {
			n := SSL_write(cast(SSL)req.tls, raw_data(chunk), c.int(len(chunk)))
			if n <= 0 {
				// An EOF while still sending the request is a failure, not
				// completion, so .Eof falls in with .Fatal here.
				if fetch_tls_classify(loop, req, n) != .Pending {
					fetch_settle_error(req, "fetch: TLS write failed")
				}
				return
			}
			req.write_offset += int(n)
			continue
		}
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

// fetch_read drains the response — decrypting TLS records for https, reading raw
// socket bytes for http — until EOF, then settles.
fetch_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	buf: [16384]byte
	for {
		if req.is_https {
			n := SSL_read(cast(SSL)req.tls, raw_data(buf[:]), c.int(len(buf)))
			if n <= 0 {
				switch fetch_tls_classify(loop, req, n) {
				case .Pending:
				case .Eof:
					fetch_settle_response(req) // response complete
				case .Fatal:
					fetch_settle_error(req, "fetch: TLS read failed")
				}
				return
			}
			append(&req.response, ..buf[:n])
			continue
		}
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
