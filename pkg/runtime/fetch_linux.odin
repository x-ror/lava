#+build linux
package lava_runtime

import "core:net"
import "core:strings"
import "core:sys/linux"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Linux HTTP transport for fetch. Non-blocking connect/write/read driven by the
// event loop's IO_Watcher (io_uring or epoll). A hostname is resolved OFF the
// loop on a worker thread (so getaddrinfo never blocks the loop); a literal IP
// connects immediately. After resolution the connect/write/read lifecycle is a
// tiny state machine in fetch_watcher_cb, advanced each time the socket is ready.

fetch_close_fd :: proc(fd: uintptr) {
	linux.close(linux.Fd(fd))
}

// fetch_transport_start begins a request. An IPv6/IPv4 literal connects
// synchronously; a hostname is resolved on a background thread and the connect is
// deferred to fetch_dns_complete_cb (run back on the loop thread via post_async).
// Returns ok=false with a message only for an immediate failure; the async path
// returns ok=true and settles later.
fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
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
	eventloop.async_begin(req.loop)
	thread.create_and_start_with_data(req, fetch_dns_worker, nil, .Normal, true)
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

// fetch_connect_ip4 / fetch_connect_ip6 open a non-blocking socket, kick off
// connect(), and register the socket for writability (which signals connect
// completion). Both run on the loop thread.
fetch_connect_ip4 :: proc(req: ^Fetch_Request, ip4: [4]u8, port: int) -> (ok: bool, err: string) {
	sock_fd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE do return false, "fetch: could not create socket"
	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(port),
		sin_addr   = ip4,
	}
	if conn_err := linux.connect(sock_fd, &addr); conn_err != .NONE && conn_err != .EINPROGRESS {
		linux.close(sock_fd)
		return false, "fetch: connect failed"
	}
	return fetch_register_socket(req, sock_fd)
}

fetch_connect_ip6 :: proc(req: ^Fetch_Request, ip6: net.IP6_Address, port: int) -> (ok: bool, err: string) {
	sock_fd, sock_err := linux.socket(.INET6, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE do return false, "fetch: could not create socket"
	// IP6_Address is [8]u16be, whose memory layout is already the 16 network-order
	// bytes sin6_addr expects.
	addr := linux.Sock_Addr_In6 {
		sin6_family = .INET6,
		sin6_port   = u16be(port),
		sin6_addr   = transmute([16]u8)ip6,
	}
	if conn_err := linux.connect(sock_fd, &addr); conn_err != .NONE && conn_err != .EINPROGRESS {
		linux.close(sock_fd)
		return false, "fetch: connect failed"
	}
	return fetch_register_socket(req, sock_fd)
}

// fetch_register_socket records the connecting socket on the request and watches
// it for writability (connect completion). Loop thread only.
fetch_register_socket :: proc(req: ^Fetch_Request, fd: linux.Fd) -> (ok: bool, err: string) {
	req.fd = uintptr(fd)
	req.has_fd = true
	req.phase = .Connecting
	req.watcher = eventloop.IO_Watcher {
		fd        = uintptr(fd),
		mode      = .Write, // writable == connect complete (or error via SO_ERROR)
		callback  = fetch_watcher_cb,
		user_data = req,
	}
	if !eventloop.watch_fd(req.loop, &req.watcher) {
		linux.close(fd)
		req.has_fd = false
		return false, "fetch: could not register socket with the event loop"
	}
	return true, ""
}

// fetch_switch_to_read flips the socket's watch from writability to readability
// once the request has been fully written. The io_uring backend re-arms from
// watcher.mode after this callback returns, so mutating the field is enough;
// epoll needs an explicit re-registration.
fetch_switch_to_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	if loop.platform.use_uring {
		req.watcher.mode = .Read
		return
	}
	eventloop.unwatch_fd(loop, &req.watcher)
	req.watcher.mode = .Read
	eventloop.watch_fd(loop, &req.watcher)
}

// fetch_watcher_cb advances the request whenever the socket is ready. Connect →
// write the whole request → read until EOF, then settle. EAGAIN means "not
// ready, wait for the next event".
fetch_watcher_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Fetch_Request)user_data
	if req == nil || req.settled do return
	fd := linux.Fd(req.fd)

	switch req.phase {
	case .Connecting:
		// getsockopt_base takes the output pointer directly; the typed wrappers wrap
		// it in a way that does not fit a plain i32 out-param.
		so_error: i32
		_, opt_err := linux.getsockopt_base(fd, cast(int)linux.SOL_SOCKET, linux.Socket_Option.ERROR, &so_error)
		if opt_err != .NONE || so_error != 0 {
			fetch_settle_error(req, "fetch: connection failed")
			return
		}
		req.phase = .Writing
		fallthrough // socket is writable now, try sending immediately

	case .Writing:
		for req.write_offset < len(req.request_bytes) {
			n, send_err := linux.send(fd, req.request_bytes[req.write_offset:], {})
			#partial switch send_err {
			case .NONE:
			case .EAGAIN: // == EWOULDBLOCK
				return // wait for the next writable event
			case:
				fetch_settle_error(req, "fetch: send failed")
				return
			}
			if n <= 0 do return
			req.write_offset += n
		}
		fetch_switch_to_read(loop, req)
		req.phase = .Reading // next readable event reads the response

	case .Reading:
		buf: [16384]byte
		for {
			n, recv_err := linux.recv(fd, buf[:], {})
			#partial switch recv_err {
			case .NONE:
			case .EAGAIN: // == EWOULDBLOCK
				return // wait for more data
			case:
				fetch_settle_error(req, "fetch: receive failed")
				return
			}
			if n == 0 {
				fetch_settle_response(req) // EOF — server closed, response complete
				return
			}
			append(&req.response, ..buf[:n])
		}
	}
}
