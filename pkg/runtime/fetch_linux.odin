#+build linux
package lava_runtime

import "core:net"
import "core:sys/linux"
import eventloop "lava:pkg/runtime/eventloop"

// Linux HTTP transport for fetch. Non-blocking connect/write/read driven by the
// event loop's IO_Watcher (io_uring or epoll). DNS still resolves synchronously
// (v1); everything after that is asynchronous. The whole lifecycle for one
// request is a tiny state machine in fetch_watcher_cb, advanced each time the
// socket signals readiness.

fetch_close_fd :: proc(fd: uintptr) {
	linux.close(linux.Fd(fd))
}

// fetch_transport_start resolves the host, opens a non-blocking socket, kicks
// off connect(), and registers the socket for writability (which signals
// connect completion). On failure it returns ok=false with a message; the
// caller rejects.
fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	endpoint, dns_err := net.resolve_ip4(host)
	if dns_err != nil do return false, "fetch: could not resolve host"
	ip4, ip_ok := endpoint.address.(net.IP4_Address)
	if !ip_ok do return false, "fetch: host has no IPv4 address"

	fd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE do return false, "fetch: could not create socket"

	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(port),
		sin_addr   = transmute([4]u8)ip4,
	}
	conn_err := linux.connect(fd, &addr)
	if conn_err != .NONE && conn_err != .EINPROGRESS {
		linux.close(fd)
		return false, "fetch: connect failed"
	}

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
