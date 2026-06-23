#+build linux
package eventloop

import "core:sys/linux"
import "core:testing"

// Unit tests for the io_uring completion-op primitive (submit_recv/submit_send/cancel_op and
// the op-slot table). A connected AF_UNIX socketpair stands in for a TCP connection. The
// runtime-dependent tests skip when io_uring (or the RECV/SEND opcodes) are unavailable
// (proactor_available); the token-encoding test is pure and always runs.

Proactor_Rec :: struct {
	recv_buf:  [64]u8,
	recv_res:  i32,
	recv_done: bool,
	send_res:  i32,
	send_done: bool,
	disposed:  bool,
}

proactor_on_recv :: proc(loop: ^Loop, ud: rawptr, res: i32) {
	rec := cast(^Proactor_Rec)ud
	rec.recv_res = res
	rec.recv_done = true
}

proactor_on_send :: proc(loop: ^Loop, ud: rawptr, res: i32) {
	rec := cast(^Proactor_Rec)ud
	rec.send_res = res
	rec.send_done = true
}

proactor_on_dispose :: proc(ud: rawptr) {
	rec := cast(^Proactor_Rec)ud
	rec.disposed = true
}

@(private = "file")
proactor_noop_timer :: proc(loop: ^Loop, ud: rawptr) {}

// arm_watchdog bounds each subsequent run_once poll with a timer deadline, so a completion
// that never arrives makes the test FAIL (the bounded pump exits) instead of hanging on
// run_once's otherwise-unbounded wait (active I/O, no timer).
@(private = "file")
arm_watchdog :: proc(loop: ^Loop) {
	set_timeout(loop, proactor_noop_timer, 1000, nil)
}

@(private = "file")
make_socketpair :: proc(t: ^testing.T) -> (sv: [2]linux.Fd, ok: bool) {
	if linux.socketpair(.UNIX, .STREAM, .HOPOPT, &sv) != .NONE {
		testing.expect(t, false, "socketpair failed")
		return sv, false
	}
	return sv, true
}

// 1) RECV on one end + SEND on the other both complete with the right byte counts; the
//    received bytes match; the in-flight count drains to zero.
@(test)
proactor_recv_send_roundtrip :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	msg := [5]u8{'h', 'e', 'l', 'l', 'o'}
	testing.expect(t, submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, nil, &rec) != OP_ID_INVALID, "recv submit")
	testing.expect(t, submit_send(&loop, uintptr(sv[1]), msg[:], proactor_on_send, nil, &rec) != OP_ID_INVALID, "send submit")

	arm_watchdog(&loop)
	for i in 0 ..< 5 {
		if rec.recv_done && rec.send_done do break
		run_once(&loop)
	}
	testing.expect(t, rec.send_done, "send did not complete")
	testing.expect_value(t, rec.send_res, 5)
	testing.expect(t, rec.recv_done, "recv did not complete")
	testing.expect_value(t, rec.recv_res, 5)
	testing.expect_value(t, string(rec.recv_buf[:5]), "hello")
	testing.expect_value(t, loop.active_io_count, 0)
}

// 2) A short read completes with the actual count, not the buffer capacity.
@(test)
proactor_recv_short_read :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	three := [3]u8{'a', 'b', 'c'}
	testing.expect(t, submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, nil, &rec) != OP_ID_INVALID)
	testing.expect(t, submit_send(&loop, uintptr(sv[1]), three[:], proactor_on_send, nil, &rec) != OP_ID_INVALID)
	arm_watchdog(&loop)
	for i in 0 ..< 5 {
		if rec.recv_done && rec.send_done do break
		run_once(&loop)
	}
	testing.expect_value(t, rec.recv_res, 3)
	testing.expect_value(t, string(rec.recv_buf[:3]), "abc")
}

// 3) cancel_op tears down a RECV pending with no data: its terminal CQE fires the callback
//    with a negative result (-ECANCELED) and drains the in-flight count.
@(test)
proactor_cancel_op :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	id := submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, nil, &rec) // no peer send → pending
	testing.expect(t, id != OP_ID_INVALID, "recv submit")
	cancel_op(&loop, id)

	arm_watchdog(&loop)
	for i in 0 ..< 5 {
		if rec.recv_done do break
		run_once(&loop)
	}
	testing.expect(t, rec.recv_done, "cancelled recv did not deliver a terminal completion")
	testing.expect(t, rec.recv_res < 0, "cancelled recv should complete with a negative result")
	testing.expect_value(t, loop.active_io_count, 0)
}

// 4) An op still in flight at loop destruction is dropped via its disposer (exactly-once: the
//    callback never fired because no CQE was drained), so the caller can reclaim its buffer.
@(test)
proactor_dispose_on_destroy :: proc(t: ^testing.T) {
	loop := init()
	if !proactor_available(&loop) {
		destroy(&loop)
		return
	}
	sv, sp_ok := make_socketpair(t)
	if !sp_ok {
		destroy(&loop)
		return
	}
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	id := submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, proactor_on_dispose, &rec)
	testing.expect(t, id != OP_ID_INVALID, "recv submit")

	destroy(&loop) // ring torn down with the RECV in flight → disposer runs, callback does not
	testing.expect(t, rec.disposed, "in-flight op was not disposed at destroy")
	testing.expect(t, !rec.recv_done, "callback must not fire for an op dropped at destroy")
}

// 5) NOSIGNAL: a SEND to a peer that has closed surfaces as a negative completion, not a
//    SIGPIPE that kills the process.
@(test)
proactor_send_to_closed_peer :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	linux.close(sv[0]) // close the peer; sv[1] sends into a dead connection
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	msg := [4]u8{'d', 'e', 'a', 'd'}
	testing.expect(t, submit_send(&loop, uintptr(sv[1]), msg[:], proactor_on_send, nil, &rec) != OP_ID_INVALID)
	arm_watchdog(&loop)
	for i in 0 ..< 5 {
		if rec.send_done do break
		run_once(&loop)
	}
	testing.expect(t, rec.send_done, "send to closed peer did not complete")
	testing.expect(t, rec.send_res < 0, "send to closed peer should complete with a negative result")
}

// 6) A nil completion callback is refused (no observer for the exactly-once completion): no
//    op is submitted, no slot or in-flight count is created.
@(test)
proactor_nil_callback_rejected :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	id := submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], nil, nil, &rec)
	testing.expect_value(t, id, OP_ID_INVALID)
	testing.expect_value(t, loop.active_io_count, 0)
}

// 7) Token encoding (pure, backend-independent): op tokens round-trip index+generation, carry
//    the op-domain bit, and never collide with poll-watcher tokens or the reserved sentinels.
@(test)
proactor_token_encoding :: proc(t: ^testing.T) {
	cases := [][2]u32{{0, 1}, {1, 1}, {7, 42}, {0xFFFF, 0x7FFF_FFFF}, {0xFFFF_FFFF, 5}}
	for c in cases {
		tok := uring_op_encode_token(c[0], c[1])
		testing.expect(t, tok & URING_OP_DOMAIN != 0, "op token must carry the domain bit")
		testing.expect_value(t, uring_op_token_index(tok), c[0])
		testing.expect_value(t, uring_op_token_generation(tok), c[1])
		testing.expect(t, tok != URING_WAKEUP_USER_DATA && tok != URING_CANCEL_USER_DATA, "op token collides with a sentinel")
	}
	// A poll-watcher token (no domain bit) is distinguishable from an op token.
	watcher_tok := uring_encode_token(3, 9)
	testing.expect(t, watcher_tok & URING_OP_DOMAIN == 0, "watcher token must not carry the op-domain bit")
}

// 8) Slot table: alloc → release bumps the generation (old token goes stale) and frees the
//    index for O(1) reuse.
@(test)
proactor_slot_reuse :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	a := uring_op_alloc_slot(&loop, proactor_on_recv, nil, nil)
	idx := uring_op_token_index(a)
	testing.expect(t, uring_op_slot_live(&loop, idx, uring_op_token_generation(a)), "fresh slot live")
	uring_op_release_slot(&loop, idx)
	testing.expect(t, !uring_op_slot_live(&loop, idx, uring_op_token_generation(a)), "released token must be stale")

	b := uring_op_alloc_slot(&loop, proactor_on_recv, nil, nil)
	testing.expect_value(t, uring_op_token_index(b), idx) // reused the freed index
	testing.expect(t, uring_op_token_generation(b) != uring_op_token_generation(a), "reused slot must bump generation")
	uring_op_release_slot(&loop, uring_op_token_index(b))
}

// 9) Provided-buffer ring (Slice 2a/2b): a ring recv delivers the kernel-selected buffer with the
//    correct bytes (NOT a false zero-byte EOF — the len=buffer-size guard for Linux 5.19), recycles
//    it, and — under multishot (2b) — delivers a SECOND chunk from the SAME submission (more=true,
//    no re-arm). Verifies the F_MORE accounting: active_io_count stays at 1 across the intermediate
//    CQEs and returns to 0 only after the op's terminal (cancel) CQE. Skips if the ring is
//    unavailable (older kernel / no NODROP); single-shot kernels take the re-arm fallback.
Ring_Rec :: struct {
	res:     i32,
	has_buf: bool,
	more:    bool,
	got:     [64]u8,
	got_len: int,
	done:    bool,
}

ring_on_recv :: proc(loop: ^Loop, ud: rawptr, res: i32, bid: u16, has_buf: bool, more: bool) {
	rec := cast(^Ring_Rec)ud
	rec.res, rec.has_buf, rec.more = res, has_buf, more
	if has_buf && res > 0 {
		rec.got_len = copy(rec.got[:], recv_ring_buf(loop, bid, int(res))) // copy BEFORE recycle
	}
	if has_buf do recv_ring_recycle(loop, bid)
	rec.done = true
}

@(private = "file")
ring_pump :: proc(t: ^testing.T, loop: ^Loop, rec: ^Ring_Rec, peer: linux.Fd, msg: string) {
	rec.done = false
	_, _ = linux.send(peer, transmute([]u8)msg, {})
	arm_watchdog(loop)
	for _ in 0 ..< 64 {
		if rec.done do break
		run_once(loop)
	}
}

@(test)
proactor_ring_recv_recycle :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !bufring_available(&loop) do return // ring unsupported on this kernel — skip

	sv, sp_ok := make_socketpair(t)
	if !sp_ok do return
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Ring_Rec{}
	id := submit_recv_ring(&loop, uintptr(sv[0]), ring_on_recv, nil, &rec)
	testing.expect(t, id != OP_ID_INVALID, "ring recv submit")
	testing.expect_value(t, loop.active_io_count, 1)

	ring_pump(t, &loop, &rec, sv[1], "hello")
	testing.expect(t, rec.done, "ring recv did not deliver")
	testing.expect(t, rec.has_buf, "ring recv must carry a kernel-selected buffer")
	testing.expect_value(t, rec.res, 5) // NOT 0 — the len=buffer-size guard (Linux 5.19)
	testing.expect_value(t, string(rec.got[:rec.got_len]), "hello")

	if rec.more {
		// 2b multishot: the SAME submission delivers the next chunk (no re-arm); the op stays in
		// flight (active_io_count still 1) across the intermediate CQE.
		testing.expect_value(t, loop.active_io_count, 1)
		ring_pump(t, &loop, &rec, sv[1], "world")
		testing.expect_value(t, string(rec.got[:rec.got_len]), "world")
		testing.expect_value(t, loop.active_io_count, 1)
		// Cancel the still-armed multishot; its terminal CQE releases the op → count back to 0.
		cancel_op(&loop, id)
		arm_watchdog(&loop)
		for _ in 0 ..< 64 {
			if loop.active_io_count == 0 do break
			run_once(&loop)
		}
	} else {
		// 2a single-shot: terminal already (op released); re-arm explicitly for the next chunk.
		testing.expect_value(t, loop.active_io_count, 0)
		id2 := submit_recv_ring(&loop, uintptr(sv[0]), ring_on_recv, nil, &rec)
		testing.expect(t, id2 != OP_ID_INVALID, "second single-shot ring submit")
		ring_pump(t, &loop, &rec, sv[1], "world")
		testing.expect_value(t, string(rec.got[:rec.got_len]), "world")
	}
	testing.expect_value(t, loop.active_io_count, 0)
}
