package eventloop

import "core:mem"
import "core:testing"
import "core:thread"
import "core:time"

Recorder :: struct {
	events:        [dynamic]int,
	interval_id:   Timer_ID,
	dispose_count: int,
}

// count_dispose is a Dispose hook: the loop calls it for a handle it drops
// without (re-)firing, mirroring how the JS bridge frees a cleared timer's
// binding. It must run exactly once per cancelled handle and never for one that
// fired and "freed itself" (a double-free in the real bridge).
count_dispose :: proc(user_data: rawptr) {
	rec := cast(^Recorder)user_data
	rec.dispose_count += 1
}

record :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
}

record_2 :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 2)
}

record_3 :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 3)
}

record_and_queue_microtask :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	queue_microtask(loop, record_2, user_data)
}

record_and_schedule_timer :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	set_timeout(loop, record_3, 0, user_data)
}

record_and_schedule_immediate :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	set_immediate(loop, record_2, user_data)
}

record_interval_and_clear_after_two_ticks :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	if len(rec.events) == 2 {
		clear_interval(loop, rec.interval_id)
	}
}

record_and_queue_next_tick :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	queue_next_tick(loop, record_2, user_data)
}

expect_events :: proc(t: ^testing.T, actual: []int, expected: []int) {
	if !testing.expect_value(t, len(actual), len(expected)) {
		return
	}

	for value, i in actual {
		testing.expect_value(t, value, expected[i])
	}
}

@(test)
microtasks_are_fifo :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record, &rec)
	queue_microtask(&loop, record_2, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
next_ticks_run_before_microtasks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_2, &rec)
	queue_next_tick(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
next_ticks_queued_by_microtasks_are_drained_before_leaving_checkpoint :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_and_queue_next_tick, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 3, 2})
}

@(test)
nested_microtasks_drain_in_same_turn :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	queue_microtask(&loop, record_and_queue_microtask, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 3, 2})
}

@(test)
immediates_run_after_due_timers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_immediate(&loop, record_2, &rec)
	set_timeout(&loop, record, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
io_callbacks_run_before_immediates :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Even when the immediate is queued first, the poll-phase I/O callback runs
	// ahead of the check-phase immediate within the same tick.
	set_immediate(&loop, record_2, &rec)
	queue_io_callback(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
io_callback_scheduling_immediate_runs_in_order :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Mirrors the 08-io-before-immediate oracle case: an fs.readFile-style poll
	// completion records, then schedules a setImmediate that records after it.
	queue_io_callback(&loop, record_and_schedule_immediate, &rec)

	run_until_idle(&loop)
	expect_events(t, rec.events[:], []int{1, 2})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
cleared_immediate_does_not_run :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_immediate(&loop, record, &rec)
	testing.expect(t, clear_immediate(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
}

@(test)
interval_repeats_until_cleared :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	rec.interval_id = set_interval(&loop, record_interval_and_clear_after_two_ticks, 5, &rec)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 1})
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect_value(t, now(&loop), u64(10))
}

@(test)
timers_are_ordered_by_due_time_then_insertion :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_3, 20, &rec)
	set_timeout(&loop, record, 10, &rec)
	set_timeout(&loop, record_2, 10, &rec)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
	testing.expect_value(t, now(&loop), u64(20))
}

@(test)
cleared_timer_does_not_run :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 0, &rec)
	testing.expect(t, clear_timeout(&loop, id))
	testing.expect(t, !clear_timeout(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
}

// --- Dispose-hook (binding cleanup) regression: clearing a timer/immediate must
// release its binding exactly once, and a normally-fired one-shot must not be
// disposed (that path frees its own binding — a double-free in the real bridge).

@(test)
cleared_timeout_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 5, &rec, count_dispose)
	testing.expect(t, clear_timeout(&loop, id))
	// No other pending work: run_until_idle must not even tick. The binding is
	// freed eagerly at clear, not lazily on a later tick that may never come.
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
fired_timeout_is_not_disposed :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record, 0, &rec, count_dispose)
	testing.expect(t, run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 1)
	// A one-shot that fired freed itself; the loop must not also dispose it.
	testing.expect_value(t, rec.dispose_count, 0)
}

@(test)
cleared_immediate_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_immediate(&loop, record, &rec, count_dispose)
	testing.expect(t, clear_immediate(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
cleared_pending_interval_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_interval(&loop, record, 5, &rec, count_dispose)
	// Cleared before it ever fires: its binding must still be released.
	testing.expect(t, clear_interval(&loop, id))
	testing.expect(t, !run_until_idle(&loop))
	testing.expect_value(t, len(rec.events), 0)
	testing.expect_value(t, rec.dispose_count, 1)
}

@(test)
interval_cleared_from_own_callback_disposes_binding :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Fires twice, then clears itself: it fired (so it was not freed on fire,
	// unlike a one-shot) and is not re-armed, so it is disposed exactly once.
	rec.interval_id = set_interval(
		&loop,
		record_interval_and_clear_after_two_ticks,
		5,
		&rec,
		count_dispose,
	)
	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1, 1})
	testing.expect_value(t, rec.dispose_count, 1)
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
microtasks_run_before_due_timers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_2, 0, &rec)
	queue_microtask(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2})
}

@(test)
microtasks_drain_between_timer_callbacks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_and_queue_microtask, 0, &rec)
	set_timeout(&loop, record_3, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
timer_scheduled_by_timer_waits_for_next_turn :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_timeout(&loop, record_and_schedule_timer, 0, &rec)

	testing.expect(t, run_once(&loop))
	expect_events(t, rec.events[:], []int{1})
	testing.expect_value(t, pending_count(&loop), 1)

	testing.expect(t, run_next(&loop))
	expect_events(t, rec.events[:], []int{1, 3})
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
close_callbacks_run_after_immediates :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// setImmediate (check phase) must fire before close callbacks
	set_immediate(&loop, record_2, &rec)
	queue_close_callback(&loop, record_3, &rec)
	queue_microtask(&loop, record, &rec)

	testing.expect(t, run_once(&loop))
	// order: microtask(1) → immediate/check(2) → close(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
unreffed_timer_does_not_keep_loop_alive :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 100, &rec)
	timer_unref(&loop, id)

	// Loop should be considered idle because the only timer is unreffed
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect(t, !has_pending_work(&loop))
}

@(test)
refd_timer_keeps_loop_alive :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	id := set_timeout(&loop, record, 100, &rec)
	timer_unref(&loop, id)
	timer_ref(&loop, id)

	testing.expect_value(t, pending_count(&loop), 1)
	testing.expect(t, has_pending_work(&loop))
}

@(test)
next_tick_queued_inside_next_tick_runs_before_microtasks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// next_tick queues another next_tick; that must run before any microtask
	queue_next_tick(&loop, record_and_queue_next_tick, &rec)
	queue_microtask(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	// record(1) fires, queues next_tick(2); next_tick(2) fires; then microtask(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

@(test)
microtasks_drain_between_immediate_callbacks :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	set_immediate(&loop, record_and_queue_microtask, &rec)
	set_immediate(&loop, record_3, &rec)

	testing.expect(t, run_once(&loop))
	// immediate(1) fires → queues microtask(2); microtask(2) drains; then immediate(3)
	expect_events(t, rec.events[:], []int{1, 2, 3})
}

// --- Cross-thread wakeup ---
// wakeup() must unblock a loop parked in platform_poll from another thread. This
// is the primitive every background-worker feature (async DNS, thread-pool
// offload) relies on; it regressed silently before #74 because nothing exercised
// it (a worker would write the wakeup fd but the poll never woke).

wakeup_worker :: proc(data: rawptr) {
	loop := cast(^Loop)data
	// Give the main thread time to reach the blocking poll, then wake it.
	time.sleep(50 * time.Millisecond)
	wakeup(loop)
}

@(test)
wakeup_unblocks_blocking_poll :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	thread.create_and_start_with_data(&loop, wakeup_worker, context, .Normal, true)

	// Blocks until the worker calls wakeup(); reaching the next line proves the
	// cross-thread wakeup woke the poll. (A regression hangs here — by design,
	// since the whole point is that the poll must be wakeable.)
	platform_poll(&loop, -1)
	testing.expect(t, true)
}

// --- Cross-thread async-completion handoff (the primitive async DNS uses) ---

Async_Arg :: struct {
	loop: ^Loop,
	rec:  ^Recorder,
}

// async_worker runs off-loop, then posts a completion back to the loop. post_async
// is the only loop call allowed from another thread.
async_worker :: proc(data: rawptr) {
	arg := cast(^Async_Arg)data
	time.sleep(20 * time.Millisecond)
	post_async(arg.loop, record, arg.rec)
}

@(test)
async_handoff_runs_posted_callback :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)
	arg := Async_Arg{loop = &loop, rec = &rec}

	// One off-loop op in flight keeps the loop alive and parked in poll until the
	// worker posts its completion via the wakeup.
	async_begin(&loop)
	testing.expect_value(t, pending_count(&loop), 1)
	thread.create_and_start_with_data(&arg, async_worker, context, .Normal, true)

	testing.expect(t, run_until_idle(&loop))
	expect_events(t, rec.events[:], []int{1}) // posted callback ran on the loop thread
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

@(test)
run_ignores_stale_wakeup_while_async_is_active :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)
	arg := Async_Arg{loop = &loop, rec = &rec}

	async_begin(&loop)
	wakeup(&loop)
	thread.create_and_start_with_data(&arg, async_worker, context, .Normal, true)

	run(&loop)

	expect_events(t, rec.events[:], []int{1})
	testing.expect_value(t, loop.active_async, 0)
	testing.expect_value(t, pending_count(&loop), 0)
}

// --- Per-tick temp arena reset ---

record_and_alloc_temp :: proc(loop: ^Loop, user_data: rawptr) {
	rec := cast(^Recorder)user_data
	append(&rec.events, 1)
	// Per-tick scratch, like the runtime's fetch response parsing / fs paths.
	_, _ = mem.alloc(4096, allocator = context.temp_allocator)
}

@(test)
run_resets_temp_allocator_each_tick :: proc(t: ^testing.T) {
	// A fixed 8 KiB arena as the temp allocator: four ticks each allocating
	// 4 KiB of scratch only fit if run() resets the arena between ticks.
	buf: [8192]byte
	arena: mem.Arena
	mem.arena_init(&arena, buf[:])
	context.temp_allocator = mem.arena_allocator(&arena)

	loop := init()
	defer destroy(&loop)

	rec := Recorder{}
	defer delete(rec.events)

	// Distinct deadlines so each callback fires on its own tick.
	for delay in 1 ..= 4 {
		set_timeout(&loop, record_and_alloc_temp, u64(delay), &rec)
	}

	run(&loop)

	expect_events(t, rec.events[:], []int{1, 1, 1, 1}) // no callback hit an exhausted arena
	testing.expect_value(t, arena.offset, 0) // every tick's scratch was reclaimed
}

@(test)
async_cancel_undoes_begin :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// async_begin marks an off-loop op in flight; if dispatch then fails (e.g. a
	// worker thread couldn't spawn), async_cancel must undo it so the loop is not
	// kept alive — and run_until_idle must return immediately, not block.
	async_begin(&loop)
	testing.expect_value(t, pending_count(&loop), 1)
	async_cancel(&loop)
	testing.expect_value(t, pending_count(&loop), 0)
	testing.expect(t, !has_pending_work(&loop))
	testing.expect(t, !run_until_idle(&loop))
}

@(test)
backend_error_stops_run_drivers :: proc(t: ^testing.T) {
	loop := init()
	defer destroy(&loop)

	// An in-flight off-loop op keeps the loop alive: has_pending_work stays true,
	// so without the backend_error escape the run drivers would spin forever once
	// platform_poll can no longer make progress (a fatal poll syscall error).
	async_begin(&loop)
	testing.expect(t, has_pending_work(&loop))

	// Simulate platform_poll flagging a fatal backend error.
	loop.backend_error = true

	// Both drivers must return promptly rather than busy-spin. (A regression here
	// shows up as the test hanging until the runner times out.)
	testing.expect(t, !run_until_idle(&loop))
	run(&loop)
	testing.expect(t, loop.backend_error) // flag is preserved for the embedder
}
