package eventloop

import "core:testing"

Recorder :: struct {
	events:      [dynamic]int,
	interval_id: Timer_ID,
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
