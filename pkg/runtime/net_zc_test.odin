#+build linux
package lava_runtime

import "core:sys/linux"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"

// Direct-invocation tests for the SEND_ZC two-axis state machine (Slice 3b, net_send_zc_complete).
// A real kernel two-CQE pinned sequence is unobservable in CI (loopback always copies; AF_UNIX has no
// send-zerocopy), so — per the design — the state machine is driven by calling net_send_zc_complete
// with crafted (res, more) tuples on a hand-built connection. This reaches the error/copied/fallback
// cells the large-body integration test cannot. `inflight` is held high so net_maybe_free never fires
// mid-test (the test owns the conn's lifetime); read_done is set so the drain's recv re-arm no-ops; the
// JS callbacks are nil so net_emit is a no-op (no JSC context needed).

@(private = "file")
zc_conn :: proc(loop: ^eventloop.Loop, fd: linux.Fd, body_len: int) -> ^Net_Connection {
	conn := new(Net_Connection)
	conn.loop = loop
	conn.fd = uintptr(fd)
	conn.io_mode = .Proactor
	conn.read_done = true // drain's net_maybe_arm_recv returns early — no recv setup needed
	conn.inflight = 1000 // sentinel: maybe_free's (closing && inflight==0) never fires during the test
	conn.send_op = eventloop.Op_ID(0xABCD) // a non-INVALID placeholder; the terminal clears it
	conn.active_send = make([dynamic]byte)
	resize(&conn.active_send, body_len)
	return conn
}

@(private = "file")
zc_free :: proc(conn: ^Net_Connection) {
	delete(conn.active_send)
	delete(conn.pending_writes)
	free(conn)
}

// (a) RESULT CQE (more=true), res>=0: INV-1 records ONLY off (no clear/finish/submit/close).
@(test)
zc_result_records_off_only :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, -1, 100)
	defer zc_free(conn)

	net_send_zc_complete(&loop, conn, 60, true) // partial result: 60 of 100 bytes
	testing.expect_value(t, conn.active_send_off, 60)
	testing.expect(t, conn.saw_result, "saw_result set by the result CQE")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "INV-1: result must NOT clear send_op")
	testing.expect(t, !conn.closing, "INV-1: result must NOT close")
}

// (b) RESULT CQE (more=true), res<0: errored-but-pinned — record zc_err, leave off untouched (INV-4),
//     surface nothing yet (INV-1). The owed terminal handles it.
@(test)
zc_result_errored_pinned_records_err :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 100, 100)
	defer zc_free(conn)

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EPIPE), true)
	testing.expect_value(t, conn.zc_err, -i32(linux.Errno.EPIPE))
	testing.expect_value(t, conn.active_send_off, 0) // INV-4: off untouched on a negative result
	testing.expect(t, !conn.closing, "INV-1: no close on a more=true CQE even when errored")
}

// (c) TERMINAL after a successful full transmission (saw=true, off==len): clear send_op, drain.
@(test)
zc_terminal_drained :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 100, 100)
	defer zc_free(conn)
	conn.saw_result = true
	conn.active_send_off = 100 // the result CQE already advanced off to len

	net_send_zc_complete(&loop, conn, 0, false) // notif: res ignored (INV-3)
	testing.expect_value(t, conn.send_op, eventloop.OP_ID_INVALID) // cleared first
	testing.expect_value(t, len(conn.active_send), 0) // fully drained → backing cleared
	testing.expect(t, !conn.closing, "a clean drain must not close")
}

// (d) Single-CQE COPIED success (saw=false, more=false, res>0): the kernel declined zerocopy — advance
//     off like a plain success, do NOT close (Codex#3 — the cell that used to hit the fatal branch).
@(test)
zc_terminal_copied_success_not_close :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 50, 50)
	defer zc_free(conn)
	// saw_result stays false (no prior more=true result): a single F_MORE-clear res>0 CQE.

	net_send_zc_complete(&loop, conn, 50, false)
	testing.expect(t, !conn.closing, "a copied (single-CQE) success must NOT close the connection")
	testing.expect_value(t, len(conn.active_send), 0) // off advanced to len → drained
}

// (e) Single-CQE zero-byte stall (saw=false, res==0): close (plain-path parity).
@(test)
zc_terminal_stall_closes :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 100, 100)
	defer zc_free(conn)

	net_send_zc_complete(&loop, conn, 0, false)
	testing.expect(t, conn.closing, "a zero-byte stall must close")
	testing.expect(t, conn.had_error, "stall close is an error close")
}

// (f) -EINVAL on a ZC op (saw=false, send_was_zc): capability fallback — latch zc_ok off, re-submit
//     PLAIN (send_op re-set), NOT fatal.
@(test)
zc_terminal_einval_falls_back_plain :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 100, 100)
	defer zc_free(conn)
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.EINVAL), false)
	testing.expect(t, !eventloop.send_zc_ok(&loop), "EINVAL on a ZC op latches zc_ok off")
	testing.expect(t, !conn.closing, "EINVAL capability fallback must NOT close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "fallback re-submitted (plain) — send_op re-set")
	testing.expect(t, !conn.send_was_zc, "the fallback re-submit chose plain")
}

// (g) -ENOBUFS (optmem pressure): transient copy-send fallback — re-submit, NOT fatal, zc NOT latched.
@(test)
zc_terminal_enobufs_not_fatal :: proc(t: ^testing.T) {
	loop := eventloop.init()
	defer eventloop.destroy(&loop)
	if !eventloop.proactor_available(&loop) do return
	conn := zc_conn(&loop, 100, 100)
	defer zc_free(conn)
	conn.send_was_zc = true

	net_send_zc_complete(&loop, conn, -i32(linux.Errno.ENOBUFS), false)
	testing.expect(t, !conn.closing, "ENOBUFS (optmem) must be transient, NOT a fatal close")
	testing.expect(t, conn.send_op != eventloop.OP_ID_INVALID, "ENOBUFS re-submitted the tail")
}
