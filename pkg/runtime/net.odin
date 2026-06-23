#+build linux
package lava_runtime

import "base:runtime"
import "core:c"
import "core:net"
import "core:os"
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

// Proactor (io_uring completion-mode) tunables — see docs/io-uring-proactor.md (Slice 1b).
// A per-conn recv landing buffer is a real idle-memory cost vs the readiness path's transient
// stack buffer (Slice 2's provided-buffer ring reclaims it), so it is smaller than NET_READ_CHUNK.
NET_PROACTOR_RECV :: 16 * 1024
// Outbound high-water mark: write() reports backpressure (and reads pause) only when this many
// bytes are buffered, NOT merely because a send op is in flight (every io_uring send is async).
NET_WRITE_HWM :: 16 * 1024

// A connection's I/O backend, chosen ONCE at start: .Proactor only after a successful first
// submit_recv, else .Readiness (the epoll-style watcher path). close/write/end/shutdown branch
// on this, never on proactor_available or op-ID liveness (both IDs are invalid after EOF on a
// live proactor conn).
Net_IO_Mode :: enum u8 {
	Readiness = 0,
	Proactor,     // io_uring completion, per-conn recv_buf (Slice 1b)
	ProactorRing, // io_uring completion, shared provided-buffer ring (Slice 2a) — no recv_buf
}

// net_is_proactor reports whether the connection uses ANY proactor backend (Proactor or
// ProactorRing). The send path + teardown are identical for both, so every shared branch tests
// this — NOT `io_mode == .Proactor` by equality, which would route a ProactorRing conn down the
// readiness path and free it with a kernel recv still armed (UAF). The recv path branches on the
// exact mode (per-conn buffer vs ring).
net_is_proactor :: proc(conn: ^Net_Connection) -> bool {
	return conn.io_mode == .Proactor || conn.io_mode == .ProactorRing
}

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
	on_drain:        jsc.JSObjectRef, // proactor: fired when the outbound buffer empties
	handlers_set:    bool,
	// Pending outbound bytes not yet accepted by the kernel send buffer. Bound to the
	// default heap on first append (a proc "c" runs under runtime.default_context); the
	// dynamic array carries that allocator, so delete() frees it correctly anywhere.
	write_queue:     [dynamic]byte,
	writing:         bool, // watcher currently in .Write mode (draining a blocked write)
	end_after_drain: bool, // socket.end() / read EOF: close once write_queue empties
	read_done:       bool, // peer half-closed (read EOF) — never re-arm the read watcher
	closing:         bool,
	// --- proactor (io_uring completion) state; io_mode == .Proactor ---------------
	io_mode:         Net_IO_Mode,
	recv_buf:        []byte, // reused kernel landing zone (copied per chunk; never JSC no-copy)
	recv_op:         eventloop.Op_ID, // live RECV (OP_ID_INVALID == none in flight)
	send_op:         eventloop.Op_ID, // live SEND
	// active_send is the IMMUTABLE buffer currently submitted to send_op (the op submits
	// active_send[active_send_off:]); pending_writes is the mutable queue appends land in.
	// Both stay [dynamic]byte (a []byte would drop the allocator/capacity) and are ROTATED
	// (swapped + cleared), never reallocated, so a backing the kernel is reading never moves.
	active_send:     [dynamic]byte,
	active_send_off: int,
	pending_writes:  [dynamic]byte,
	inflight:        int, // submitted-but-not-completed ops; the conn outlives its ops
	read_paused:     bool, // reads not re-armed while buffered >= NET_WRITE_HWM
	want_drain:      bool, // write() returned backpressure; a 'drain' is owed
	silent_close:    bool, // teardown at loop shutdown: free without firing 'close'
	had_error:       bool, // sticky: set true by any net_close_conn(.., true)
	recv_starved:    bool, // ProactorRing: on the state.net_starved_* FIFO after -ENOBUFS (no ring buffer)
	starved_next:    ^Net_Connection, // intrusive starved-FIFO links (valid only while recv_starved)
	starved_prev:    ^Net_Connection,
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
	context = runtime.default_context() // allocate Net_Connection on the heap net_maybe_free frees with
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
	if argument_count >= 6 do conn.on_drain = callback_arg(ctx, args[5])
	net_protect(ctx, conn.on_data)
	net_protect(ctx, conn.on_end)
	net_protect(ctx, conn.on_close)
	net_protect(ctx, conn.on_error)
	net_protect(ctx, conn.on_drain)
	conn.handlers_set = true

	// Prefer the proactor. The mode is chosen at this FIRST submit only (rev.4): try the shared
	// provided-buffer ring (Slice 2a — no per-conn buffer, the memory moat); if the ring is
	// unavailable, try the 1b per-conn-buffer single-shot; if neither submits, fall back to the
	// readiness watcher. The mode is set ONLY on a successful submit (never count a failed one).
	if !net_force_readiness() && eventloop.proactor_available(conn.loop) {
		if eventloop.bufring_available(conn.loop) {
			id := eventloop.submit_recv_ring(conn.loop, conn.fd, net_recv_ring_complete, on_op_dispose, conn)
			if id != eventloop.OP_ID_INVALID {
				conn.io_mode = .ProactorRing // no recv_buf — reads draw from the shared ring
				conn.recv_op = id
				conn.inflight += 1
				return jsc.JSValueMakeUndefined(ctx)
			}
		}
		conn.recv_buf = make([]byte, NET_PROACTOR_RECV, context.allocator)
		id := eventloop.submit_recv(conn.loop, conn.fd, conn.recv_buf, on_recv_complete, on_op_dispose, conn)
		if id != eventloop.OP_ID_INVALID {
			conn.io_mode = .Proactor
			conn.recv_op = id
			conn.inflight += 1
			return jsc.JSValueMakeUndefined(ctx)
		}
		delete(conn.recv_buf, context.allocator)
		conn.recv_buf = nil
	}

	conn.io_mode = .Readiness
	conn.watcher = eventloop.IO_Watcher {
		fd        = conn.fd,
		mode      = .Read,
		callback  = conn_read_cb,
		user_data = conn,
	}
	// If the watcher can't be registered (loop resource exhaustion), the conn has an open fd and
	// protected handlers but no I/O — tear it down rather than strand it. (Rare; the handlers are
	// already registered, so 'close' still reports the failure to a listener attached this tick.)
	if !eventloop.watch_fd(conn.loop, &conn.watcher) {
		net_emit_error(conn, "could not register connection with the event loop")
		net_close_conn(conn, true)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// net_force_readiness reports whether LAVA_NET_FORCE_READINESS is set — a TEST-ONLY switch that
// makes every connection take the epoll/readiness fallback instead of the proactor, so CI can
// exercise both backends on the same (proactor-capable) kernel. Read once and cached.
@(private = "file")
net_force_readiness_state: enum u8 {
	Unknown,
	No,
	Yes,
}

net_force_readiness :: proc() -> bool {
	if net_force_readiness_state == .Unknown {
		net_force_readiness_state =
			os.get_env("LAVA_NET_FORCE_READINESS", context.temp_allocator) != "" ? .Yes : .No
	}
	return net_force_readiness_state == .Yes
}

// --- proactor (io_uring completion) connection I/O ---------------------------
//
// See docs/io-uring-proactor.md (Slice 1b). The connection holds an `inflight` op refcount so
// it OUTLIVES its in-flight recv/send ops; the single free site (net_maybe_free) runs only when
// closing && inflight == 0, so the kernel never touches a freed buffer and {callback XOR dispose}
// fires exactly once per op. All of these run on the loop thread (op completions / disposers).

// net_maybe_arm_recv is the SOLE place a RECV is submitted: at most one is ever in flight (two
// kernel ops writing the one recv_buf would corrupt it), and never after EOF, while reads are
// paused by backpressure, or during teardown. read_paused is recomputed here so it can't go stale.
// net_maybe_arm_recv returns whether it actually submitted a recv: false when it can't arm right now
// (closing/EOF, a recv already in flight, or write-backpressured) or the submit failed (it then
// closes the conn — and `conn` may already be freed, so the caller must NOT touch it after a false).
net_maybe_arm_recv :: proc(conn: ^Net_Connection) -> bool {
	if conn.closing || conn.read_done do return false
	if conn.recv_op != eventloop.OP_ID_INVALID do return false // a recv is already in flight
	conn.read_paused = net_proactor_buffered(conn) >= NET_WRITE_HWM
	if conn.read_paused do return false
	id: eventloop.Op_ID
	if conn.io_mode == .ProactorRing {
		// Shared ring: no per-conn buffer; the kernel picks one at completion (net_recv_ring_complete).
		id = eventloop.submit_recv_ring(conn.loop, conn.fd, net_recv_ring_complete, on_op_dispose, conn)
	} else {
		id = eventloop.submit_recv(conn.loop, conn.fd, conn.recv_buf, on_recv_complete, on_op_dispose, conn)
	}
	if id == eventloop.OP_ID_INVALID {
		net_emit_error(conn, "read submit failed")
		net_close_conn(conn, true)
		return false
	}
	conn.recv_op = id
	conn.inflight += 1
	return true
}

// net_recv_ring_complete: a provided-buffer-ring RECV terminal CQE (Slice 2a). ORDER is load-bearing
// (rev.4): COPY the kernel-selected buffer while we still own it, RECYCLE it unconditionally (even
// when closing — a leaked bid drains the shared ring and wedges every conn on -ENOBUFS), THEN deliver.
net_recv_ring_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32, bid: u16, has_buf: bool) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	conn.recv_op = eventloop.OP_ID_INVALID
	// 1) Copy FIRST, while the buffer is ours (recycling republishes it; the kernel may overwrite).
	arg: jsc.JSValueRef = nil
	if has_buf && res > 0 && !conn.closing {
		if src := eventloop.recv_ring_buf(loop, bid, int(res)); src != nil {
			copy_buf := make([]byte, len(src), context.allocator)
			copy(copy_buf, src)
			arg = make_uint8_array(conn.ctx, copy_buf)
		}
	}
	// 2) Recycle UNCONDITIONALLY (after the copy), then re-arm one conn parked on -ENOBUFS.
	if has_buf {
		eventloop.recv_ring_recycle(loop, bid)
		if state := get_state_from_ctx(conn.ctx); state != nil do net_refill_starved(state)
	}
	// 3) Deliver / handle. op_finished is the LAST conn access (reentrant destroy() safe).
	if !conn.closing {
		if res > 0 {
			if arg != nil do net_emit(conn.ctx, conn.on_data, &arg, 1)
			net_maybe_arm_recv(conn)
		} else if res == 0 {
			conn.read_done = true
			net_emit(conn.ctx, conn.on_end, nil, 0)
		} else if res == -i32(linux.Errno.ENOBUFS) {
			net_park_or_rearm(conn) // ring was momentarily empty
		} else if res == -i32(linux.Errno.EINTR) || res == -i32(linux.Errno.EAGAIN) {
			net_maybe_arm_recv(conn)
		} else if res != -i32(linux.Errno.ECANCELED) {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
		}
	}
	net_op_finished(conn)
}

// NET_RECV_CREDIT_MAX caps banked refill credits at the ring size: there can never be more than that
// many free ring buffers, so a larger bank would over-re-arm a -ENOBUFS burst. It must track
// eventloop's URING_BUFRING_ENTRIES (a different package); they match today, and a mismatch is SAFE —
// too-high only causes a bounded, self-correcting futile re-arm, too-low an extra park woken by the
// next recycle — never a stranded connection.
NET_RECV_CREDIT_MAX :: 256

// --- starved FIFO (intrusive doubly-linked, O(1) enqueue/dequeue/remove) ---

@(private = "file")
net_starved_enqueue :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	conn.starved_next = nil
	conn.starved_prev = state.net_starved_tail
	if state.net_starved_tail != nil do state.net_starved_tail.starved_next = conn
	else do state.net_starved_head = conn
	state.net_starved_tail = conn
}

@(private = "file")
net_starved_dequeue :: proc(state: ^Runtime_State) -> ^Net_Connection {
	conn := state.net_starved_head
	if conn == nil do return nil
	state.net_starved_head = conn.starved_next
	if state.net_starved_head != nil do state.net_starved_head.starved_prev = nil
	else do state.net_starved_tail = nil
	conn.starved_next, conn.starved_prev = nil, nil
	return conn
}

@(private = "file")
net_starved_unlink :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	if conn.starved_prev != nil do conn.starved_prev.starved_next = conn.starved_next
	else do state.net_starved_head = conn.starved_next
	if conn.starved_next != nil do conn.starved_next.starved_prev = conn.starved_prev
	else do state.net_starved_tail = conn.starved_prev
	conn.starved_next, conn.starved_prev = nil, nil
}

// net_park_or_rearm handles a ProactorRing -ENOBUFS (no ring buffer was selected). The kernel posted
// this CQE when the ring was empty, but a buffer may have been recycled since: if a credit is banked
// (a recycle that found no parked taker — see net_refill_starved) consume it and re-arm NOW, closing
// the lost-wakeup; otherwise park on the starved FIFO and take a loop-liveness ref (async_begin) so
// the loop cannot exit with our peer's data unread — a future recycle re-arms us.
net_park_or_rearm :: proc(conn: ^Net_Connection) {
	if conn.closing || conn.read_done do return
	state := get_state_from_ctx(conn.ctx)
	if state == nil do return
	if state.net_recv_credits > 0 {
		state.net_recv_credits -= 1
		net_maybe_arm_recv(conn)
		return
	}
	if conn.recv_starved do return // no duplicate insertion
	conn.recv_starved = true
	net_starved_enqueue(state, conn)
	eventloop.async_begin(conn.loop)
}

// net_refill_starved is called once per recycled buffer (one freed buffer). It hands that buffer to
// the FIFO-first parked conn that can actually arm a recv NOW — re-arming exactly one (re-arming all
// would storm, since most would re-fault -ENOBUFS). A conn that can't take the buffer this moment is
// unparked and SKIPPED, NOT charged the wakeup (net_maybe_arm_recv returns false): a closing/EOF conn
// never re-arms, and a write-backpressured conn is re-armed by its own drain transition
// (net_proactor_on_drained), not here — charging either would strand the freed buffer while conns
// behind it stay parked with unread data (Codex review). If no parked conn can arm, the buffer is
// banked as a credit (capped) for a conn that parks before the next recycle, so the wakeup is never lost.
net_refill_starved :: proc(state: ^Runtime_State) {
	for {
		conn := net_starved_dequeue(state)
		if conn == nil do break
		conn.recv_starved = false
		eventloop.async_cancel(conn.loop) // drop the parked liveness ref
		if net_maybe_arm_recv(conn) do return // armed → this conn consumes the wakeup
		// else couldn't arm (closing/EOF/backpressured/submit-failed) — try the next parked conn
	}
	if state.net_recv_credits < NET_RECV_CREDIT_MAX do state.net_recv_credits += 1
}

// net_unpark removes a conn from the starved FIFO before it is freed (lifetime safety: a later
// recycle must never walk a freed conn), releasing its liveness ref. O(1).
net_unpark :: proc(state: ^Runtime_State, conn: ^Net_Connection) {
	if !conn.recv_starved do return
	conn.recv_starved = false
	eventloop.async_cancel(conn.loop)
	net_starved_unlink(state, conn)
}

// on_recv_complete: a RECV terminal CQE. Decrement+maybe-free is the LAST act (op_finished),
// after all JS and conn access, so a synchronous destroy() inside on_data cannot free the conn
// out from under this callback (the inflight count is the callback's lifetime reference).
on_recv_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	conn.recv_op = eventloop.OP_ID_INVALID
	if !conn.closing {
		if res > 0 {
			// Copy out of the reused landing buffer into a JSC-owned Uint8Array (no-copy handoff
			// frees copy_buf on GC). The landing buffer must NOT be handed to JSC — it is reused.
			n := int(res)
			copy_buf := make([]byte, n, context.allocator)
			copy(copy_buf, conn.recv_buf[:n])
			arg := make_uint8_array(conn.ctx, copy_buf)
			net_emit(conn.ctx, conn.on_data, &arg, 1)
			net_maybe_arm_recv(conn) // its guards handle a handler that closed/paused
		} else if res == 0 {
			conn.read_done = true // half-close: never re-arm
			net_emit(conn.ctx, conn.on_end, nil, 0)
		} else if res == -i32(linux.Errno.EINTR) || res == -i32(linux.Errno.EAGAIN) {
			net_maybe_arm_recv(conn) // transient — a fresh submit (kernel re-polls), not a spin
		} else if res != -i32(linux.Errno.ECANCELED) {
			net_emit_error(conn, "read error")
			net_close_conn(conn, true)
		}
		// -ECANCELED: our own teardown cancel; no error, just let op_finished reclaim.
	}
	net_op_finished(conn)
}

// net_proactor_buffered: outbound bytes not yet handed to the kernel (unsent active tail + queue).
net_proactor_buffered :: proc(conn: ^Net_Connection) -> int {
	return (len(conn.active_send) - conn.active_send_off) + len(conn.pending_writes)
}

// net_proactor_submit_send submits active_send[off:] (the tail not yet sent). Loop thread.
net_proactor_submit_send :: proc(conn: ^Net_Connection) {
	id := eventloop.submit_send(conn.loop, conn.fd, conn.active_send[conn.active_send_off:], on_send_complete, on_op_dispose, conn)
	if id == eventloop.OP_ID_INVALID {
		net_emit_error(conn, "write submit failed")
		net_close_conn(conn, true)
		return
	}
	conn.send_op = id
	conn.inflight += 1
}

// net_proactor_kick_send rotates pending_writes into active_send and submits, if no send is in
// flight and there is data. Rotation (swap + clear) preserves each backing's allocator/capacity.
net_proactor_kick_send :: proc(conn: ^Net_Connection) {
	if conn.closing do return
	if conn.send_op != eventloop.OP_ID_INVALID do return // a send is already in flight
	if len(conn.pending_writes) == 0 do return
	conn.active_send, conn.pending_writes = conn.pending_writes, conn.active_send
	clear(&conn.pending_writes)
	conn.active_send_off = 0
	net_proactor_submit_send(conn)
}

// on_send_complete: a SEND terminal CQE. Advances the offset, re-submits a partial tail, rotates
// the next queued chunk, or runs the drain transition when fully drained.
on_send_complete :: proc(loop: ^eventloop.Loop, user_data: rawptr, res: i32) {
	context = runtime.default_context()
	conn := cast(^Net_Connection)user_data
	conn.send_op = eventloop.OP_ID_INVALID
	if !conn.closing {
		if res > 0 {
			conn.active_send_off += int(res)
			if conn.active_send_off < len(conn.active_send) {
				net_proactor_submit_send(conn) // partial send — re-submit the unsent tail
			} else if len(conn.pending_writes) > 0 {
				net_proactor_kick_send(conn) // active drained; send the queued chunk next
			} else {
				clear(&conn.active_send) // fully drained (keep the backing for reuse)
				conn.active_send_off = 0
				net_proactor_on_drained(conn)
			}
		} else if res == 0 {
			net_emit_error(conn, "write stalled") // zero-progress on a non-empty send
			net_close_conn(conn, true)
		} else if res == -i32(linux.Errno.EINTR) || res == -i32(linux.Errno.EAGAIN) {
			net_proactor_submit_send(conn) // transient — re-submit the tail (a fresh op)
		} else if res != -i32(linux.Errno.ECANCELED) {
			net_emit_error(conn, "write error")
			net_close_conn(conn, true)
		}
	}
	net_op_finished(conn)
}

// net_proactor_on_drained runs the reentrancy-safe drain transition: clear want_drain BEFORE
// emitting 'drain' (the listener may write >= HWM again or destroy()), then re-check state and
// re-arm reads / close only against the FRESH state.
net_proactor_on_drained :: proc(conn: ^Net_Connection) {
	if conn.want_drain {
		conn.want_drain = false
		net_emit(conn.ctx, conn.on_drain, nil, 0)
	}
	if conn.closing do return // a 'drain' listener destroyed the socket
	net_maybe_arm_recv(conn) // recomputes read_paused from the (possibly new) buffered count
	if conn.end_after_drain && conn.send_op == eventloop.OP_ID_INVALID && len(conn.pending_writes) == 0 {
		net_close_conn(conn, false)
	}
}

// net_op_finished is every completion's LAST act: drop the op's lifetime reference, then free
// the conn iff it is closing and no op remains.
net_op_finished :: proc(conn: ^Net_Connection) {
	conn.inflight -= 1
	net_maybe_free(conn)
}

// on_op_dispose: an op dropped without a terminal CQE (only at loop destruction). No JS reentry
// here, so it decrements immediately. Both ops carry the same conn; the last one frees it.
on_op_dispose :: proc(user_data: rawptr) {
	context = runtime.default_context()
	net_op_finished(cast(^Net_Connection)user_data)
}

// net_maybe_free is the SINGLE free site for a proactor conn. It finalizes only on the inflight
// 1->0 transition while closing (NOT idempotent — a call after free would be a UAF; but inflight
// == 0 means no op remains to call it again). The fd is closed BEFORE 'close' is emitted, and the
// conn is dropped from the registry before any JS runs so a reentrant destroy() can't re-enter.
net_maybe_free :: proc(conn: ^Net_Connection) {
	if !conn.closing || conn.inflight > 0 do return
	// Pin the default heap: recv_buf/active_send/pending_writes are allocated under
	// runtime.default_context (the proc"c" entry points) and the conn under net_accept_cb's
	// (also default) context, so free them the same way regardless of the ambient context when
	// this runs (e.g. net_shutdown_active / an Op_Dispose during eventloop.destroy).
	context = runtime.default_context()
	linux.close(linux.Fd(conn.fd))
	if state := get_state_from_ctx(conn.ctx); state != nil do delete_key(&state.net_conns, conn.id)
	if !conn.silent_close {
		had := jsc.JSValueMakeBoolean(conn.ctx, b32(conn.had_error))
		net_emit(conn.ctx, conn.on_close, &had, 1)
	}
	net_unprotect(conn.ctx, conn.on_data)
	net_unprotect(conn.ctx, conn.on_end)
	net_unprotect(conn.ctx, conn.on_close)
	net_unprotect(conn.ctx, conn.on_error)
	net_unprotect(conn.ctx, conn.on_drain)
	delete(conn.recv_buf)
	delete(conn.active_send)
	delete(conn.pending_writes)
	free(conn)
}

// net_close_conn_proactor: mark closing once, wake any op pending on an idle peer via
// shutdown(SHUT_RDWR) (cancel_op alone is best-effort), cancel for promptness, then maybe_free
// (finalizes immediately if no op is in flight — e.g. after a peer EOF). had_error is sticky.
net_close_conn_proactor :: proc(conn: ^Net_Connection, had_error: bool) {
	if had_error do conn.had_error = true // sticky, BEFORE the idempotency guard
	if conn.closing do return
	conn.closing = true
	// Remove from the -ENOBUFS starved list FIRST (lifetime safety: a later recycle must never
	// re-arm/walk a conn that maybe_free is about to free).
	if conn.recv_starved {
		if state := get_state_from_ctx(conn.ctx); state != nil do net_unpark(state, conn)
	}
	linux.shutdown(linux.Fd(conn.fd), .RDWR)
	eventloop.cancel_op(conn.loop, conn.recv_op)
	eventloop.cancel_op(conn.loop, conn.send_op)
	net_maybe_free(conn)
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

	if net_is_proactor(conn) {
		// Hold a lifetime reference for the call: net_proactor_kick_send can fail a submit and
		// synchronously close — and, if no op were in flight, free — the conn; the guard keeps it
		// alive until we have read its state and computed the return (mirrors a completion's ref).
		conn.inflight += 1
		defer net_op_finished(conn)
		if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
			append(&conn.pending_writes, ..view)
		}
		net_proactor_kick_send(conn)
		if conn.closing do return jsc.JSValueMakeBoolean(ctx, false)
		if net_proactor_buffered(conn) >= NET_WRITE_HWM {
			conn.want_drain = true // backpressure (Node's write()==false); a 'drain' is owed
			return jsc.JSValueMakeBoolean(ctx, false)
		}
		return jsc.JSValueMakeBoolean(ctx, true)
	}

	if view, ok := typed_array_view(ctx, args[1]); ok && len(view) > 0 {
		append(&conn.write_queue, ..view)
	}
	backpressured := net_flush(conn)
	if backpressured do conn.want_drain = true // owe a 'drain' once the queue empties
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
	// Fire the owed 'drain' (readiness parity with the proactor path) so a JS writer that
	// stopped on write()==false resumes. Reentrancy-safe: clear before emit (the listener may
	// write again — re-arming want_drain — or destroy()), then bail if it closed us.
	if conn.want_drain {
		conn.want_drain = false
		net_emit(conn.ctx, conn.on_drain, nil, 0)
		if conn.closing do return false
	}
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
	if net_is_proactor(conn) {
		// Guarded like net_write_cb: kick / close below may free the conn otherwise.
		conn.inflight += 1
		defer net_op_finished(conn)
		net_proactor_kick_send(conn)
		// Nothing left to drain → close now; otherwise on_send_complete closes once drained.
		if !conn.closing && conn.send_op == eventloop.OP_ID_INVALID && len(conn.pending_writes) == 0 {
			net_close_conn(conn, false)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
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
	if conn == nil do return
	if net_is_proactor(conn) {
		net_close_conn_proactor(conn, had_error)
		return
	}
	if conn.closing do return
	conn.closing = true
	eventloop.unwatch_fd(conn.loop, &conn.watcher) // idempotent if never armed
	linux.close(linux.Fd(conn.fd))

	had := jsc.JSValueMakeBoolean(conn.ctx, b32(had_error))
	net_emit(conn.ctx, conn.on_close, &had, 1)
	net_unprotect(conn.ctx, conn.on_data)
	net_unprotect(conn.ctx, conn.on_end)
	net_unprotect(conn.ctx, conn.on_close)
	net_unprotect(conn.ctx, conn.on_error)
	net_unprotect(conn.ctx, conn.on_drain) // net.js always registers onDrain, even on readiness
	conn.on_data, conn.on_end, conn.on_close, conn.on_error, conn.on_drain = nil, nil, nil, nil, nil

	if state := get_state_from_ctx(conn.ctx); state != nil do delete_key(&state.net_conns, conn.id)
	eventloop.async_begin(conn.loop)
	eventloop.post_async(conn.loop, net_conn_free_cb, conn)
}

net_conn_free_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context() // free with the same heap net_accept_cb/proc"c" allocated under
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
	context = runtime.default_context() // alloc/free conns + buffers on the default heap (see net_maybe_free)
	// net_maybe_free deletes a freed proactor conn from net_conns, so iterate a snapshot.
	conns := make([dynamic]^Net_Connection, 0, len(state.net_conns))
	defer delete(conns)
	for _, conn in state.net_conns do append(&conns, conn)
	for conn in conns {
		if net_is_proactor(conn) {
			// ALWAYS silence + unprotect the proactor conn (no JS during teardown), whether it is
			// freshly closing or was ALREADY closing with a live op — otherwise that op's later
			// Op_Dispose reaches net_maybe_free with silent_close==false and fires the JS 'close'
			// mid-destroy. Clearing the handlers also makes maybe_free's unprotect a no-op.
			conn.silent_close = true
			net_unprotect(conn.ctx, conn.on_data)
			net_unprotect(conn.ctx, conn.on_end)
			net_unprotect(conn.ctx, conn.on_close)
			net_unprotect(conn.ctx, conn.on_error)
			net_unprotect(conn.ctx, conn.on_drain)
			conn.on_data, conn.on_end, conn.on_close, conn.on_error, conn.on_drain = nil, nil, nil, nil, nil
			if conn.recv_starved {
				conn.recv_starved = false // the whole starved list is cleared after this loop
				eventloop.async_cancel(conn.loop) // balance the parked liveness ref
			}
			if !conn.closing {
				// Not yet closing: wake any op pending on an idle peer + cancel for promptness.
				conn.closing = true
				linux.shutdown(linux.Fd(conn.fd), .RDWR)
				eventloop.cancel_op(conn.loop, conn.recv_op)
				eventloop.cancel_op(conn.loop, conn.send_op)
			}
			// Zero-inflight (e.g. post-EOF, no op/disposer) finalizes now; a live-op conn is a
			// no-op here and is freed by its Op_Dispose during eventloop.destroy, which the
			// deferred teardown runs BEFORE destroy_runtime_state deletes net_conns (so the
			// disposer's delete_key stays valid).
			net_maybe_free(conn)
			continue
		}
		if conn.closing do continue // readiness: already torn down; its deferred free is dropped at destroy
		conn.closing = true
		eventloop.unwatch_fd(conn.loop, &conn.watcher)
		linux.close(linux.Fd(conn.fd))
		net_unprotect(conn.ctx, conn.on_data)
		net_unprotect(conn.ctx, conn.on_end)
		net_unprotect(conn.ctx, conn.on_close)
		net_unprotect(conn.ctx, conn.on_error)
		net_unprotect(conn.ctx, conn.on_drain)
		delete(conn.write_queue)
		free(conn)
	}
	clear(&state.net_conns) // live-op proactor conns (if any) are freed by their Op_Dispose
	state.net_starved_head, state.net_starved_tail = nil, nil // FIFO emptied (conns freed above / by disposer)
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
	// net_starved is an intrusive list (head/tail pointers, no backing allocation) — nothing to free.
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
