package eventloop

import "core:testing"

// Graceful-shutdown primitive (Slice 3a): request_shutdown -> the loop observes it once on the loop
// thread and runs the drain-start hook; run() exits once the drain driver flips force_exit. Driven
// single-threaded here (the supervisor's cross-thread request is the same atomic store + wakeup), so
// the tests are deterministic. The hook always either forces immediately (no connections) or arms a
// drain timer (connections pending) — a hook that does neither would leave the loop with nothing to
// do and block in poll, which is exactly the real drain contract, not a test artifact.

@(private = "file")
Shutdown_Rec :: struct {
	hook_fired:  int,
	timer_fired: int,
}

// force-immediately hook: simulates "stop requested, no connections in flight" -> exit at once.
@(private = "file")
shutdown_force_hook :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Shutdown_Rec)user_data
	rec.hook_fired += 1
	begin_force_exit(loop)
}

// drain-timer hook: simulates "stop requested, connections still draining" -> arm a short drain
// timeout that forces exit when it fires (the bounded-drain deadline).
@(private = "file")
shutdown_drain_hook :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Shutdown_Rec)user_data
	rec.hook_fired += 1
	set_timeout(loop, shutdown_drain_timeout, 5, user_data)
}

@(private = "file")
shutdown_drain_timeout :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Shutdown_Rec)user_data
	rec.timer_fired += 1
	begin_force_exit(loop)
}

@(private = "file")
shutdown_far_timer :: proc(loop: ^Loop, ud: rawptr) {}

// 1) request_shutdown -> the hook fires exactly once (latched), and run() exits via force_exit even
//    with pending work (a far-future timer stands in for a listening server's perpetual I/O).
@(test)
shutdown_force_exits_run :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Shutdown_Rec{}
	set_shutdown_hook(&loop, shutdown_force_hook, &rec)
	set_timeout(&loop, shutdown_far_timer, 100_000, nil) // run() would never exit on its own

	testing.expect(t, !shutdown_requested(&loop), "no stop yet")
	request_shutdown(&loop)
	testing.expect(t, shutdown_requested(&loop), "stop requested")

	run(&loop) // must return promptly via force_exit, not block in the 100s poll
	testing.expect_value(t, rec.hook_fired, 1)
	testing.expect(t, loop.force_exit, "force_exit set")
}

// 2) Drain-then-force: the hook does NOT force immediately (connections pending) but arms a drain
//    timeout; run() keeps running until that timeout fires and forces. The hook still fires once.
@(test)
shutdown_drain_timeout_forces :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Shutdown_Rec{}
	set_shutdown_hook(&loop, shutdown_drain_hook, &rec)
	set_timeout(&loop, shutdown_far_timer, 100_000, nil) // perpetual work, so run_once is entered to observe the stop

	request_shutdown(&loop)
	run(&loop) // observe -> arm 5ms drain timeout -> timeout forces -> exit
	testing.expect_value(t, rec.hook_fired, 1)
	testing.expect_value(t, rec.timer_fired, 1)
	testing.expect(t, loop.force_exit, "force_exit set by the drain timeout")
}
