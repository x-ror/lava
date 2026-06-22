#+build linux
package eventloop

import "core:sys/linux"
import "core:testing"

// Slice 1a unit test for the io_uring completion-op primitive (submit_recv/submit_send).
// A connected AF_UNIX socketpair stands in for a TCP connection: we submit a RECV on one
// end and a SEND on the other, pump the loop, and assert both completions fire with the
// right byte counts and the received bytes match. Skipped (passes trivially) on a kernel/CI
// without io_uring, where proactor_available is false.

Proactor_Rec :: struct {
	recv_buf:  [64]u8,
	recv_res:  i32,
	recv_done: bool,
	send_res:  i32,
	send_done: bool,
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

@(test)
proactor_recv_send_roundtrip :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return // epoll-only backend: nothing to exercise

	sv: [2]linux.Fd
	if linux.socketpair(.UNIX, .STREAM, .HOPOPT, &sv) != .NONE {
		testing.fail_now(t, "socketpair failed")
	}
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	msg := [5]u8{'h', 'e', 'l', 'l', 'o'}

	testing.expect(t, submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, &rec))
	testing.expect(t, submit_send(&loop, uintptr(sv[1]), msg[:], proactor_on_send, &rec))

	// In-flight ops count as pending work, so the loop stays alive; pump until both fire
	// (bounded so a stuck completion fails fast rather than hanging).
	for i in 0 ..< 100 {
		if rec.recv_done && rec.send_done do break
		run_once(&loop)
	}

	testing.expect(t, rec.send_done, "send did not complete")
	testing.expect_value(t, rec.send_res, 5)
	testing.expect(t, rec.recv_done, "recv did not complete")
	testing.expect_value(t, rec.recv_res, 5)
	testing.expect_value(t, string(rec.recv_buf[:5]), "hello")
	// Both ops drained → the loop has no pending I/O left.
	testing.expect_value(t, loop.active_io_count, 0)
}

// A short-read RECV completes with the actual byte count, not the buffer capacity: send 3
// bytes into a 64-byte recv and assert res == 3.
@(test)
proactor_recv_short_read :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)
	if !proactor_available(&loop) do return

	sv: [2]linux.Fd
	if linux.socketpair(.UNIX, .STREAM, .HOPOPT, &sv) != .NONE {
		testing.fail_now(t, "socketpair failed")
	}
	defer linux.close(sv[0])
	defer linux.close(sv[1])

	rec := Proactor_Rec{}
	three := [3]u8{'a', 'b', 'c'}
	testing.expect(t, submit_recv(&loop, uintptr(sv[0]), rec.recv_buf[:], proactor_on_recv, &rec))
	testing.expect(t, submit_send(&loop, uintptr(sv[1]), three[:], proactor_on_send, &rec))
	for i in 0 ..< 100 {
		if rec.recv_done && rec.send_done do break
		run_once(&loop)
	}
	testing.expect_value(t, rec.recv_res, 3)
	testing.expect_value(t, string(rec.recv_buf[:3]), "abc")
}
