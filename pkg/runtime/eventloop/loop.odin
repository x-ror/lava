package eventloop

import "core:mem"

Callback :: proc(loop: ^Loop, user_data: rawptr)
Timer_ID :: u64

Backend :: enum {
	Unavailable,
	Native,
}

Phase :: enum {
	Next_Tick,
	Microtasks,
	Timers,
	Poll,
	Check,
	Close,
}

Task :: struct {
	id:        Timer_ID,
	callback:  Callback,
	user_data: rawptr,
	seq:       u64,
	cancelled: bool,
}

Timer :: struct {
	id:        Timer_ID,
	callback:  Callback,
	user_data: rawptr,
	due_ms:    u64,
	repeat_ms: u64,
	repeating: bool,
	seq:       u64,
	cancelled: bool,
}

Loop :: struct {
	backend:         Backend,
	now_ms:          u64,
	next_timer_id:   Timer_ID,
	next_sequence:   u64,
	next_ticks:      [dynamic]Task,
	microtasks:      [dynamic]Task,
	immediates:      [dynamic]Task,
	timers:          [dynamic]Timer,
	cancelled_ids:   map[Timer_ID]bool,
	running_id:      Timer_ID,
	allocator:       mem.Allocator,
	platform:        Platform_Loop,
	active_io_count: int,
	allocator:       mem.Allocator,
	platform:        Platform_Loop,
}

Poll_Mode :: enum {
	Read,
	Write,
}

IO_Watcher :: struct {
	fd:        linux.Fd,
	mode:      Poll_Mode,
	callback:  Callback,
	user_data: rawptr,
}

init :: proc(allocator := context.allocator) -> Loop {
	loop := Loop {
		backend       = .Unavailable,
		next_timer_id = 1,
		allocator     = allocator,
		cancelled_ids = make(map[Timer_ID]bool, 16, allocator),
	}

	if platform_init(&loop) {
		loop.backend = .Native
	}

	return loop
}

destroy :: proc(loop: ^Loop) {
	platform_destroy(loop)
	delete(loop.next_ticks)
	delete(loop.microtasks)
	delete(loop.immediates)
	delete(loop.timers)
	delete(loop.cancelled_ids)
	loop^ = Loop{}
}

backend_name :: proc(loop: ^Loop) -> string {
	switch loop.backend {
	case .Native:
		return platform_name(loop)
	case .Unavailable:
		return "unavailable"
	}

	return "unavailable"
}

now :: proc(loop: ^Loop) -> u64 {
	return loop.now_ms
}

pending_count :: proc(loop: ^Loop) -> int {
	return(
		len(loop.next_ticks) +
		len(loop.microtasks) +
		active_immediate_count(loop) +
		active_timer_count(loop) +
		loop.active_io_count \
	)
}

active_timer_count :: proc(loop: ^Loop) -> int {
	count := 0
	for timer in loop.timers {
		if !timer.cancelled && !is_cancel_requested(loop, timer.id) {
			count += 1
		}
	}
	return count
}

active_immediate_count :: proc(loop: ^Loop) -> int {
	count := 0
	for immediate in loop.immediates {
		if !immediate.cancelled && !is_cancel_requested(loop, immediate.id) {
			count += 1
		}
	}
	return count
}

has_pending_work :: proc(loop: ^Loop) -> bool {
	return pending_count(loop) > 0
}

queue_next_tick :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil {
		return
	}

	append(
		&loop.next_ticks,
		Task{callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
}

queue_microtask :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) {
	if callback == nil {
		return
	}

	append(
		&loop.microtasks,
		Task{callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
}

set_timeout :: proc(
	loop: ^Loop,
	callback: Callback,
	delay_ms: u64,
	user_data: rawptr = nil,
) -> Timer_ID {
	return set_timer(loop, callback, delay_ms, 0, false, user_data)
}

set_interval :: proc(
	loop: ^Loop,
	callback: Callback,
	interval_ms: u64,
	user_data: rawptr = nil,
) -> Timer_ID {
	return set_timer(loop, callback, interval_ms, interval_ms, true, user_data)
}

set_immediate :: proc(loop: ^Loop, callback: Callback, user_data: rawptr = nil) -> Timer_ID {
	if callback == nil {
		return 0
	}

	id := next_handle_id(loop)
	append(
		&loop.immediates,
		Task{id = id, callback = callback, user_data = user_data, seq = next_sequence(loop)},
	)
	return id
}

set_timer :: proc(
	loop: ^Loop,
	callback: Callback,
	delay_ms, repeat_ms: u64,
	repeating: bool,
	user_data: rawptr = nil,
) -> Timer_ID {
	if callback == nil {
		return 0
	}

	timer := Timer {
		id        = next_handle_id(loop),
		callback  = callback,
		user_data = user_data,
		due_ms    = loop.now_ms + delay_ms,
		repeat_ms = repeat_ms,
		repeating = repeating,
		seq       = next_sequence(loop),
	}

	insert_timer(loop, timer)
	return timer.id
}

clear_timeout :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	if id == 0 {
		return false
	}

	for i in 0 ..< len(loop.timers) {
		if loop.timers[i].id == id && !loop.timers[i].cancelled {
			loop.timers[i].cancelled = true
			append_cancel_request(loop, id)
			return true
		}
	}

	for i in 0 ..< len(loop.immediates) {
		if loop.immediates[i].id == id && !loop.immediates[i].cancelled {
			loop.immediates[i].cancelled = true
			append_cancel_request(loop, id)
			return true
		}
	}

	if loop.running_id == id {
		append_cancel_request(loop, id)
		return true
	}

	return false
}

clear_interval :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	return clear_timeout(loop, id)
}

clear_immediate :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	return clear_timeout(loop, id)
}

advance_time :: proc(loop: ^Loop, delta_ms: u64) {
	loop.now_ms += delta_ms
}

drain_microtasks :: proc(loop: ^Loop) {
	for len(loop.next_ticks) > 0 || len(loop.microtasks) > 0 {
		drain_task_queue(loop, &loop.next_ticks)
		drain_task_queue(loop, &loop.microtasks)
	}
}

run_once :: proc(loop: ^Loop) -> bool {
	did_work := false

	if len(loop.next_ticks) > 0 || len(loop.microtasks) > 0 {
		did_work = true
	}
	drain_microtasks(loop)

	timer_phase_sequence_limit := loop.next_sequence
	for {
		index := next_due_timer_index(loop, timer_phase_sequence_limit)
		if index < 0 {
			break
		}

		timer := loop.timers[index]
		ordered_remove(&loop.timers, index)
		if timer.cancelled || is_cancel_requested(loop, timer.id) {
			continue
		}

		did_work = true
		loop.running_id = timer.id
		timer.callback(loop, timer.user_data)
		loop.running_id = 0
		drain_microtasks(loop)

		if timer.repeating && !is_cancel_requested(loop, timer.id) {
			timer.due_ms = loop.now_ms + timer.repeat_ms
			timer.seq = next_sequence(loop)
			insert_timer(loop, timer)
		}
	}

	if !did_work && len(loop.immediates) == 0 {
		timeout_ms := get_next_timer_timeout(loop)
		if timeout_ms != 0 {
			platform_poll(loop, timeout_ms)
		}
	}

	immediate_phase_sequence_limit := loop.next_sequence
	for {
		index := next_immediate_index(loop, immediate_phase_sequence_limit)
		if index < 0 {
			break
		}

		immediate := loop.immediates[index]
		ordered_remove(&loop.immediates, index)
		if immediate.cancelled || is_cancel_requested(loop, immediate.id) {
			continue
		}

		did_work = true
		loop.running_id = immediate.id
		immediate.callback(loop, immediate.user_data)
		loop.running_id = 0
		drain_microtasks(loop)
	}

	discard_cancelled_timers(loop)
	discard_cancelled_immediates(loop)
	clear(&loop.cancelled_ids)
	return did_work
}

run_next :: proc(loop: ^Loop) -> bool {
	if len(loop.next_ticks) > 0 ||
	   len(loop.microtasks) > 0 ||
	   has_due_timer(loop) ||
	   active_immediate_count(loop) > 0 {
		return run_once(loop)
	}

	next_due, ok := next_timer_due(loop)
	if !ok {
		return false
	}

	loop.now_ms = next_due
	return run_once(loop)
}

run_until_idle :: proc(loop: ^Loop, max_iterations := 1024) -> bool {
	did_work := false

	for i in 0 ..< max_iterations {
		if !has_pending_work(loop) {
			return did_work
		}

		if !run_next(loop) {
			return did_work
		}
		did_work = true
	}

	return did_work
}

get_next_timer_timeout :: proc(loop: ^Loop) -> int {
	next_due, ok := next_timer_due(loop)
	if !ok {
		return -1
	}
	if next_due <= loop.now_ms {
		return 0
	}
	return int(next_due - loop.now_ms)
}

drain_task_queue :: proc(loop: ^Loop, queue: ^[dynamic]Task) {
	if len(queue^) == 0 {
		return
	}

	processing := queue^
	queue^ = make([dynamic]Task, 0, cap(processing), loop.allocator)
	defer delete(processing)

	for task in processing {
		if task.cancelled || (task.id != 0 && is_cancel_requested(loop, task.id)) {
			continue
		}
		task.callback(loop, task.user_data)
	}
}

next_handle_id :: proc(loop: ^Loop) -> Timer_ID {
	id := loop.next_timer_id
	loop.next_timer_id += 1
	return id
}

next_sequence :: proc(loop: ^Loop) -> u64 {
	seq := loop.next_sequence
	loop.next_sequence += 1
	return seq
}

append_cancel_request :: proc(loop: ^Loop, id: Timer_ID) {
	loop.cancelled_ids[id] = true
}

is_cancel_requested :: proc(loop: ^Loop, id: Timer_ID) -> bool {
	if id == 0 {
		return false
	}
	_, ok := loop.cancelled_ids[id]
	return ok
}

insert_timer :: proc(loop: ^Loop, timer: Timer) {
	for i in 0 ..< len(loop.timers) {
		other := loop.timers[i]
		if timer.due_ms < other.due_ms || (timer.due_ms == other.due_ms && timer.seq < other.seq) {
			append(&loop.timers, timer)
			for j := len(loop.timers) - 1; j > i; j -= 1 {
				loop.timers[j] = loop.timers[j - 1]
			}
			loop.timers[i] = timer
			return
		}
	}

	append(&loop.timers, timer)
}

has_due_timer :: proc(loop: ^Loop) -> bool {
	return next_due_timer_index(loop, loop.next_sequence) >= 0
}

next_due_timer_index :: proc(loop: ^Loop, sequence_limit: u64) -> int {
	for i in 0 ..< len(loop.timers) {
		timer := loop.timers[i]
		if timer.cancelled || is_cancel_requested(loop, timer.id) {
			continue
		}
		if timer.seq >= sequence_limit {
			continue
		}
		if timer.due_ms <= loop.now_ms {
			return i
		}
	}
	return -1
}

next_immediate_index :: proc(loop: ^Loop, sequence_limit: u64) -> int {
	for i in 0 ..< len(loop.immediates) {
		immediate := loop.immediates[i]
		if immediate.cancelled || is_cancel_requested(loop, immediate.id) {
			continue
		}
		if immediate.seq >= sequence_limit {
			continue
		}
		return i
	}
	return -1
}

next_timer_due :: proc(loop: ^Loop) -> (u64, bool) {
	for timer in loop.timers {
		if !timer.cancelled && !is_cancel_requested(loop, timer.id) {
			return timer.due_ms, true
		}
	}
	return 0, false
}

discard_cancelled_timers :: proc(loop: ^Loop) {
	i := 0
	for i < len(loop.timers) {
		if loop.timers[i].cancelled || is_cancel_requested(loop, loop.timers[i].id) {
			ordered_remove(&loop.timers, i)
			continue
		}
		i += 1
	}
}

discard_cancelled_immediates :: proc(loop: ^Loop) {
	i := 0
	for i < len(loop.immediates) {
		if loop.immediates[i].cancelled || is_cancel_requested(loop, loop.immediates[i].id) {
			ordered_remove(&loop.immediates, i)
			continue
		}
		i += 1
	}
}

watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if watcher == nil || watcher.callback == nil do return false
	if platform_watch_fd(loop, watcher) {
		loop.active_io_count += 1
		return true
	}
	return false
}

unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if watcher == nil do return false
	if platform_unwatch_fd(loop, watcher) {
		loop.active_io_count = max(0, loop.active_io_count - 1)
		return true
	}
	return false
}

// Allows background worker threads to instantly kick the event loop out of its sleep state
wakeup :: proc(loop: ^Loop) {
	platform_wakeup(loop)
}
