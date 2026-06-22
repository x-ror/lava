#+build linux
package lava_runtime

import "base:runtime"
import "core:c"
import "core:net"
import "core:sys/linux"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// node:net (TCP) — minimal server primitives on the event-loop reactor (M1). This
// is the inbound mirror of fetch's outbound socket transport (fetch_transport.odin /
// fetch_linux.odin): a listening fd is watched for readability (== a pending accept),
// each accepted connection becomes a watched fd advanced by the same IO_Watcher the
// fetch client uses. js/internal/net.js builds the public net.Server / net.Socket
// (EventEmitter) surface on top of the flat primitives exposed by make_net_bindings.
//
// Lifetime: the listener and every connection are watched fds, so watch_fd's
// active_io_count keeps the loop alive while a server listens or a connection is open
// (matching Node — the process does not exit while a server is listening). Because a
// JS handler can close its socket (or the server) synchronously from inside an accept/
// read callback, the native struct is never freed inline: net_close_* unwatches, closes
// the fd, fires the JS 'close', removes the handle from the registry, and DEFERS the
// free to the next tick via async_begin + post_async — so the in-flight callback can
// keep reading conn.closing without a use-after-free. Teardown (net_shutdown_active)
// frees whatever remains while the loop/context are still alive.

NET_READ_CHUNK :: 64 * 1024
NET_DEFAULT_BACKLOG :: 511

// Net_Server owns a listening socket. on_connection is a GC-protected JS callback
// invoked as on_connection(connId) for each accepted connection.
Net_Server :: struct {
	ctx:           jsc.JSContextRef,
	loop:          ^eventloop.Loop,
	id:            u64,
	fd:            uintptr,
	watcher:       eventloop.IO_Watcher,
	on_connection: jsc.JSObjectRef,
	closing:       bool,
}

// Net_Connection owns one accepted socket. The per-connection handlers are registered
// (and GC-protected) by net_start_cb once js/internal/net.js has built its Socket, then
// the read watcher is armed. They are payload-only (the JS handler is already bound to
// its own Socket), so on_data(buf), on_end(), on_close(hadError), on_error(message).
Net_Connection :: struct {
	ctx:             jsc.JSContextRef,
	loop:            ^eventloop.Loop,
	id:              u64,
	fd:              uintptr,
	watcher:         eventloop.IO_Watcher,
	on_data:         jsc.JSObjectRef,
	on_end:          jsc.JSObjectRef,
	on_close:        jsc.JSObjectRef,
	on_error:        jsc.JSObjectRef,
	handlers_set:    bool,
	// Pending outbound bytes not yet accepted by the kernel send buffer. Bound to the
	// default heap on first append (a proc "c" runs under runtime.default_context); the
	// dynamic array carries that allocator, so delete() frees it correctly anywhere.
	write_queue:     [dynamic]byte,
	writing:         bool, // watcher currently in .Write mode (draining a blocked write)
	end_after_drain: bool, // socket.end() / read EOF: close once write_queue empties
	read_done:       bool, // peer half-closed (read EOF) — never re-arm the read watcher
	closing:         bool,
}

// make_net_bindings builds the `native` object passed to js/internal/net.js.
make_net_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "listen", net_listen_cb)
	inject_native_function(ctx, bindings, "startConnection", net_start_cb)
	inject_native_function(ctx, bindings, "write", net_write_cb)
	inject_native_function(ctx, bindings, "end", net_end_cb)
	inject_native_function(ctx, bindings, "close", net_close_cb)
	inject_native_function(ctx, bindings, "closeServer", net_close_server_cb)
	inject_native_function(ctx, bindings, "serverPort", net_server_port_cb)
	return bindings
}

// --- listen / accept ---------------------------------------------------------

// net_listen_cb(port, host, backlog, onConnection) -> serverId. Creates a non-blocking
// listening socket, binds+listens synchronously (so a bind error throws here, matching
// where Node surfaces EADDRINUSE), and watches it for accepts. IPv4-only listener for
// M1; an unparseable/IPv6 host falls back to 0.0.0.0.
net_listen_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 {
		if exception != nil do exception^ = make_js_error(ctx, "net.listen requires (port, host, backlog, onConnection)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	port := int(jsc.JSValueToNumber(ctx, args[0], nil))
	host, host_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if host_alloc do delete(host, context.allocator)
	backlog := int(jsc.JSValueToNumber(ctx, args[2], nil))
	if backlog <= 0 do backlog = NET_DEFAULT_BACKLOG
	on_connection := callback_arg(ctx, args[3])
	if on_connection == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net.listen onConnection must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}
	loop := get_loop_from_ctx(ctx)
	state := get_state_from_ctx(ctx)
	if loop == nil || state == nil {
		if exception != nil do exception^ = make_js_error(ctx, "net: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	sfd, sock_err := linux.socket(.INET, .STREAM, {.NONBLOCK}, .TCP)
	if sock_err != .NONE {
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: could not create socket")
		return jsc.JSValueMakeUndefined(ctx)
	}
	// SO_REUSEADDR so a restart can rebind a port still in TIME_WAIT (best-effort).
	reuse: i32 = 1
	_ = linux.setsockopt(sfd, linux.SOL_SOCKET, linux.Socket_Option.REUSEADDR, &reuse)

	// Resolve the bind address. An unsupported host must NOT silently fall back to the
	// 0.0.0.0 wildcard — that would expose a server meant for loopback on every
	// interface. M1 binds IPv4 only: accept a numeric IPv4 or "localhost"; reject IPv6
	// literals and anything else (a real resolver is a later milestone).
	ip4 := net.IP4_Address{0, 0, 0, 0}
	if len(host) > 0 && host != "0.0.0.0" {
		resolved := false
		if parsed := net.parse_address(host); parsed != nil {
			#partial switch a in parsed {
			case net.IP4_Address:
				ip4 = a
				resolved = true
			}
		} else if host == "localhost" {
			ip4 = net.IP4_Address{127, 0, 0, 1}
			resolved = true
		}
		if !resolved {
			linux.close(sfd)
			if exception != nil do exception^ = make_js_error(ctx, "net.listen: unsupported host (only numeric IPv4 and 'localhost' are supported)")
			return jsc.JSValueMakeUndefined(ctx)
		}
	}
	addr := linux.Sock_Addr_In {
		sin_family = .INET,
		sin_port   = u16be(u16(port)),
		sin_addr   = transmute([4]u8)ip4,
	}
	if bind_err := linux.bind(sfd, &addr); bind_err != .NONE {
		linux.close(sfd)
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: bind failed (address in use?)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	if listen_err := linux.listen(sfd, i32(backlog)); listen_err != .NONE {
		linux.close(sfd)
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: listen failed")
		return jsc.JSValueMakeUndefined(ctx)
	}

	server := new(Net_Server)
	server.ctx = ctx
	server.loop = loop
	server.fd = uintptr(sfd)
	server.on_connection = on_connection
	server.id = state.next_net_id
	state.next_net_id += 1
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)on_connection)
	state.net_servers[server.id] = server

	server.watcher = eventloop.IO_Watcher {
		fd        = uintptr(sfd),
		mode      = .Read,
		callback  = net_accept_cb,
		user_data = server,
	}
	if !eventloop.watch_fd(loop, &server.watcher) {
		delete_key(&state.net_servers, server.id)
		jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)on_connection)
		linux.close(sfd)
		free(server)
		if exception != nil do exception^ = make_js_error(ctx, "net.listen: could not register listener with the event loop")
		return jsc.JSValueMakeUndefined(ctx)
	}
	return jsc.JSValueMakeNumber(ctx, f64(server.id))
}

// net_accept_cb drains the listener's accept backlog (edge-triggered, so loop until
// EAGAIN). Each accepted fd becomes a Net_Connection with NO read watcher yet — the
// read is armed only once JS registers handlers via startConnection, which closes the
// window where data could arrive before the Socket exists. Loop thread.
net_accept_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	server := cast(^Net_Server)user_data
	if server == nil || server.closing do return
	state := get_state_from_ctx(server.ctx)
	if state == nil do return
	for {
		addr: linux.Sock_Addr_In
		cfd, accept_err := linux.accept(linux.Fd(server.fd), &addr, {.NONBLOCK})
		if accept_err != .NONE do break // EAGAIN (drained) or a transient error — stop this round

		// TCP_NODELAY: disable Nagle so small request/response exchanges aren't stalled by
		// the ~40 ms Nagle + delayed-ACK interaction (the dominant cost on a keep-alive
		// hello-world load). Node/Bun set this by default. Best-effort.
		nodelay: i32 = 1
		_ = linux.setsockopt(cfd, linux.SOL_TCP, linux.Socket_TCP_Option.NODELAY, &nodelay)

		conn := new(Net_Connection)
		conn.ctx = server.ctx
		conn.loop = loop
		conn.fd = uintptr(cfd)
		conn.id = state.next_net_id
		state.next_net_id += 1
		state.net_conns[conn.id] = conn

		cid := jsc.JSValueMakeNumber(server.ctx, f64(conn.id))
		net_emit(server.ctx, server.on_connection, &cid, 1)
		if server.closing do break // a 'connection' handler closed the server
	}
}

// --- per-connection handler registration + reads ----------------------------

// net_start_cb(connId, onData, onEnd, onClose, onError) registers the connection's
// handlers (GC-protected) and arms the read watcher. Called by net.js right after it
// builds the Socket for a freshly accepted connection.
net_start_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 5 do return jsc.JSValueMakeUndefined(ctx)
	args := arguments[:int(argument_count)]
	conn := net_get_conn(ctx, args[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeUndefined(ctx)

	conn.on_data = callback_arg(ctx, args[1])
	conn.on_end = callback_arg(ctx, args[2])
	conn.on_close = callback_arg(ctx, args[3])
	conn.on_error = callback_arg(ctx, args[4])
	net_protect(ctx, conn.on_data)
	net_protect(ctx, conn.on_end)
	net_protect(ctx, conn.on_close)
	net_protect(ctx, conn.on_error)
	conn.handlers_set = true

	conn.watcher = eventloop.IO_Watcher {
		fd        = conn.fd,
		mode      = .Read,
		callback  = conn_read_cb,
		user_data = conn,
	}
	eventloop.watch_fd(conn.loop, &conn.watcher)
	return jsc.JSValueMakeUndefined(ctx)
}

// conn_read_cb drains the socket (edge-triggered: read until EAGAIN), delivering each
// chunk to on_data. EOF (recv==0) fires on_end then closes; a read error fires on_error
// then closes. A handler may close the socket synchronously, so after every emit we bail
// if conn.closing — safe because net_close_conn defers the actual free. Loop thread.
conn_read_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	conn := cast(^Net_Connection)user_data
	if conn == nil || conn.closing do return
	buf: [NET_READ_CHUNK]byte
	for {
		n, recv_err := linux.recv(linux.Fd(conn.fd), buf[:], {})
		if recv_err == .EINTR do continue // interrupted by a signal — retry, not fatal
		if recv_err == .EAGAIN do return // no more data buffered — wait for the next event
		if recv_err != .NONE {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
			return
		}
		if n == 0 { // peer half-closed (read EOF)
			// Stop the read watcher (EOF is persistent — it would re-fire forever) and
			// fire 'end'. Do NOT close here: this is a true half-close. The peer is done
			// sending, but the write side stays open so the app can still write (an HTTP
			// server writing its response after the client's request FIN). The connection
			// closes only when the app calls socket.end()/destroy() — the 'end' consumer
			// decides. Any in-flight (backpressured) write keeps draining via conn.writing.
			conn.read_done = true
			eventloop.unwatch_fd(conn.loop, &conn.watcher)
			net_emit(conn.ctx, conn.on_end, nil, 0)
			return
		}
		// Copy out of the transient stack buffer into a JSC-owned Uint8Array (no-copy
		// handoff frees copy_buf on GC), mirroring fetch_deliver_chunk.
		copy_buf := make([]byte, n, context.allocator)
		copy(copy_buf, buf[:n])
		arg := make_uint8_array(conn.ctx, copy_buf)
		net_emit(conn.ctx, conn.on_data, &arg, 1)
		if conn.closing do return // a data handler closed the socket
		if conn.writing do return // a data handler wrote and hit backpressure — pause reads
	}
}

// --- writes / backpressure ---------------------------------------------------

// net_write_cb(connId, data) -> bool. Queues `data` (a Uint8Array/Buffer) and tries to
// flush. Returns false when bytes remain buffered (Node's write() backpressure signal).
net_write_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeBoolean(ctx, true)
	args := arguments[:int(argument_count)]
	conn := net_get_conn(ctx, args[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeBoolean(ctx, false)

	if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
		append(&conn.write_queue, ..view)
	}
	backpressured := net_flush(conn)
	return jsc.JSValueMakeBoolean(ctx, b32(!backpressured))
}

// net_flush writes as much of write_queue as the kernel accepts. On EAGAIN it arms the
// .Write watcher and reports backpressure; on full drain it restores the .Read watcher
// and, if end() was requested, closes. Returns whether bytes remain buffered.
net_flush :: proc(conn: ^Net_Connection) -> (backpressured: bool) {
	for len(conn.write_queue) > 0 {
		sent, send_err := linux.send(linux.Fd(conn.fd), conn.write_queue[:], {.NOSIGNAL})
		if send_err == .EINTR do continue // interrupted by a signal — retry, not fatal
		if send_err == .EAGAIN {
			net_set_mode(conn, .Write) // wait for writability, then conn_write_cb drains
			return true
		}
		if send_err != .NONE {
			net_emit_error(conn, "write error")
			net_close_conn(conn, true)
			return true
		}
		if sent <= 0 do break
		remaining := len(conn.write_queue) - sent
		if remaining > 0 do copy(conn.write_queue[:], conn.write_queue[sent:])
		resize(&conn.write_queue, remaining)
	}
	// Drained. Restore read interest only if the read side is still open; after a read
	// EOF (read_done) the socket is write-only and about to close.
	if conn.writing && !conn.read_done do net_set_mode(conn, .Read)
	if conn.end_after_drain do net_close_conn(conn, false)
	return false
}

// conn_write_cb fires when a backpressured socket becomes writable again. Loop thread.
conn_write_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	conn := cast(^Net_Connection)user_data
	if conn == nil || conn.closing do return
	net_flush(conn)
}

// net_set_mode flips the connection watcher between read and write interest (the reactor
// watches one direction at a time). Mirrors fetch_set_watch_mode: unwatch, retarget,
// rewatch. Pausing reads while draining a blocked write is also correct backpressure.
net_set_mode :: proc(conn: ^Net_Connection, mode: eventloop.Poll_Mode) {
	if conn.closing do return
	eventloop.unwatch_fd(conn.loop, &conn.watcher)
	conn.watcher.mode = mode
	conn.watcher.callback = mode == .Write ? conn_write_cb : conn_read_cb
	eventloop.watch_fd(conn.loop, &conn.watcher)
	conn.writing = mode == .Write
}

// net_end_cb(connId): half of socket.end() — flush whatever is queued, then close once
// drained. (M1 closes both directions on end rather than a true SHUT_WR half-close.)
net_end_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	conn := net_get_conn(ctx, arguments[0])
	if conn == nil || conn.closing do return jsc.JSValueMakeUndefined(ctx)
	conn.end_after_drain = true
	net_flush(conn)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_close_cb(connId): destroy a socket immediately (Node socket.destroy()).
net_close_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	if conn := net_get_conn(ctx, arguments[0]); conn != nil do net_close_conn(conn, false)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_close_server_cb(serverId): stop accepting; existing connections live on (Node
// server.close semantics).
net_close_server_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	if server := net_get_server(ctx, arguments[0]); server != nil do net_close_server(server)
	return jsc.JSValueMakeUndefined(ctx)
}

// net_server_port_cb(serverId) -> number. The actual bound port (so listen(0) works).
net_server_port_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	server := net_get_server(ctx, arguments[0])
	if server == nil do return jsc.JSValueMakeNumber(ctx, 0)
	addr: linux.Sock_Addr_Any
	if linux.getsockname(linux.Fd(server.fd), &addr) != .NONE do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(u16(addr.port)))
}

// --- teardown helpers --------------------------------------------------------

// net_close_conn tears a connection down once: unwatch, close fd, fire 'close', release
// the protected handlers, drop it from the registry, and DEFER the struct free to the
// next tick (so an in-flight read/write callback can still read conn.closing safely).
// Idempotent. Loop thread.
net_close_conn :: proc(conn: ^Net_Connection, had_error: bool) {
	if conn == nil || conn.closing do return
	conn.closing = true
	eventloop.unwatch_fd(conn.loop, &conn.watcher) // idempotent if never armed
	linux.close(linux.Fd(conn.fd))

	had := jsc.JSValueMakeBoolean(conn.ctx, b32(had_error))
	net_emit(conn.ctx, conn.on_close, &had, 1)
	net_unprotect(conn.ctx, conn.on_data)
	net_unprotect(conn.ctx, conn.on_end)
	net_unprotect(conn.ctx, conn.on_close)
	net_unprotect(conn.ctx, conn.on_error)
	conn.on_data, conn.on_end, conn.on_close, conn.on_error = nil, nil, nil, nil

	if state := get_state_from_ctx(conn.ctx); state != nil do delete_key(&state.net_conns, conn.id)
	eventloop.async_begin(conn.loop)
	eventloop.post_async(conn.loop, net_conn_free_cb, conn)
}

net_conn_free_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	conn := cast(^Net_Connection)user_data
	delete(conn.write_queue)
	free(conn)
}

// net_close_server stops accepting and frees the listener (deferred, since a 'connection'
// handler may close the server from inside net_accept_cb). Existing connections are left
// running, exactly like Node's server.close().
net_close_server :: proc(server: ^Net_Server) {
	if server == nil || server.closing do return
	server.closing = true
	eventloop.unwatch_fd(server.loop, &server.watcher)
	linux.close(linux.Fd(server.fd))
	net_unprotect(server.ctx, server.on_connection)
	server.on_connection = nil
	if state := get_state_from_ctx(server.ctx); state != nil do delete_key(&state.net_servers, server.id)
	eventloop.async_begin(server.loop)
	eventloop.post_async(server.loop, net_server_free_cb, server)
}

net_server_free_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	free(cast(^Net_Server)user_data)
}

// net_shutdown_active closes every live server and connection while the loop/context are
// still alive, WITHOUT invoking JS 'close' (eval is already returning). Called from eval's
// pre-destroy teardown, mirroring fetch_shutdown_active. The deferred frees it posts are
// dropped with the async_queue at eventloop.destroy (their pointers never dereferenced).
net_shutdown_active :: proc(state: ^Runtime_State) {
	if state == nil do return
	for _, conn in state.net_conns {
		if conn.closing do continue
		conn.closing = true
		eventloop.unwatch_fd(conn.loop, &conn.watcher)
		linux.close(linux.Fd(conn.fd))
		net_unprotect(conn.ctx, conn.on_data)
		net_unprotect(conn.ctx, conn.on_end)
		net_unprotect(conn.ctx, conn.on_close)
		net_unprotect(conn.ctx, conn.on_error)
		delete(conn.write_queue)
		free(conn)
	}
	clear(&state.net_conns)
	for _, server in state.net_servers {
		if server.closing do continue
		server.closing = true
		eventloop.unwatch_fd(server.loop, &server.watcher)
		linux.close(linux.Fd(server.fd))
		net_unprotect(server.ctx, server.on_connection)
		free(server)
	}
	clear(&state.net_servers)
}

// net_destroy_state releases the registry backing once everything is shut down.
net_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	net_shutdown_active(state)
	delete(state.net_servers)
	delete(state.net_conns)
}

// --- small helpers -----------------------------------------------------------

net_get_conn :: proc(ctx: jsc.JSContextRef, id_val: jsc.JSValueRef) -> ^Net_Connection {
	state := get_state_from_ctx(ctx)
	if state == nil do return nil
	id := u64(jsc.JSValueToNumber(ctx, id_val, nil))
	if conn, ok := state.net_conns[id]; ok do return conn
	return nil
}

net_get_server :: proc(ctx: jsc.JSContextRef, id_val: jsc.JSValueRef) -> ^Net_Server {
	state := get_state_from_ctx(ctx)
	if state == nil do return nil
	id := u64(jsc.JSValueToNumber(ctx, id_val, nil))
	if server, ok := state.net_servers[id]; ok do return server
	return nil
}

net_protect :: proc(ctx: jsc.JSContextRef, fn: jsc.JSObjectRef) {
	if fn != nil do jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)fn)
}

net_unprotect :: proc(ctx: jsc.JSContextRef, fn: jsc.JSObjectRef) {
	if fn != nil do jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)fn)
}

net_emit :: proc(ctx: jsc.JSContextRef, fn: jsc.JSObjectRef, args: [^]jsc.JSValueRef, argc: c.size_t) {
	if fn == nil do return
	exception: jsc.JSValueRef
	invoke_user_callback(ctx, fn, args, argc, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}
}

net_emit_error :: proc(conn: ^Net_Connection, message: string) {
	if conn.on_error == nil do return
	arg := js_string_value(conn.ctx, message)
	net_emit(conn.ctx, conn.on_error, &arg, 1)
}
