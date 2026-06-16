#+build linux
package eventloop

import "core:sys/linux"
import "core:sys/linux/uring"
import "core:time"

// Reserved io_uring user_data sentinels. These are matched exactly in
// drain_uring_completions before any watcher decode, so a watcher token must
// never collide with them. Watcher tokens always carry a non-zero generation in
// their high 32 bits (see uring_encode_token), so they are always >= 1<<32 and
// cannot equal these small constants.
URING_WAKEUP_USER_DATA :: u64(1) // re-armed POLL_ADD on the wakeup pipe's read end
URING_CANCEL_USER_DATA :: u64(2) // ASYNC_CANCEL ops issued by unwatch (completion ignored)
// Sentinel stored in the epoll event-data union for the wakeup-pipe registration.
// The wakeup is told apart from a watcher by an exact value match, NOT by reading
// the union's `fd` field and comparing it to the pipe fd: watchers store a `ptr`
// in the same union, and a watcher pointer whose low 32 bits happen to equal the
// pipe fd would be misclassified. All-ones is never a valid (canonical) pointer.
EPOLL_WAKEUP_TOKEN :: ~u64(0)

// Uring_Watch_Slot is one entry in the io_uring watcher table — the indirection
// that makes stale poll completions memory-safe. A submitted POLL_ADD carries a
// token (slot index + generation) as its user_data, NOT the raw watcher pointer.
// A completion is mapped back to its watcher through this table; if the slot has
// since been released (generation bumped by unwatch_fd) the completion is dropped
// WITHOUT dereferencing the — possibly freed — watcher. See drain_uring_completions.
Uring_Watch_Slot :: struct {
	watcher:    ^IO_Watcher,
	generation: u32, // bumped on release so a later completion for this slot is recognized stale
	in_use:     bool,
}

Platform_Loop :: struct {
	use_uring:   bool,
	ring:        uring.Ring,
	cqes:        [32]linux.IO_Uring_CQE,
	epoll_fd:    linux.Fd,
	// Self-pipe used by wakeup() to kick the loop out of poll from another thread.
	// A pipe (not an eventfd): io_uring POLL_ADD reliably completes on a pipe fd
	// but not on an eventfd in our kernels (#74). [0] = read end, [1] = write end.
	wakeup_pipe: [2]linux.Fd,
	// Watcher table backing the generation-token scheme (io_uring only). Slots are
	// reused across watchers; the array only grows to the high-water mark of
	// concurrently watched fds, so retention stays bounded to the in-flight set.
	watch_slots: [dynamic]Uring_Watch_Slot,
}

platform_name :: proc(loop: ^Loop) -> string {
	if loop.platform.use_uring {
		return "linux-io_uring"
	}
	return "linux-epoll"
}

platform_init :: proc(loop: ^Loop) -> bool {
	loop.platform.epoll_fd = -1
	loop.platform.wakeup_pipe = {-1, -1}

	if pipe_err := linux.pipe2(&loop.platform.wakeup_pipe, {.CLOEXEC, .NONBLOCK});
	   pipe_err != nil {
		return false
	}

	params := uring.DEFAULT_PARAMS
	uring_err := uring.init(&loop.platform.ring, &params, 256)
	if uring_err == nil {
		loop.platform.use_uring = true
		// Bind the watcher table to the loop allocator (set before platform_init), so
		// it does not adopt the allocator of whatever first appends to it.
		loop.platform.watch_slots = make([dynamic]Uring_Watch_Slot, loop.allocator)

		arm_uring_poll(loop, u64(loop.platform.wakeup_pipe[0]), URING_WAKEUP_USER_DATA, {.IN})
		return true
	}

	fd, err := linux.epoll_create1({.FDCLOEXEC})
	if err != nil {
		linux.close(loop.platform.wakeup_pipe[0])
		linux.close(loop.platform.wakeup_pipe[1])
		return false
	}
	loop.platform.epoll_fd = fd

	ev: linux.EPoll_Event
	ev.events = {.IN}
	ev.data.u64 = EPOLL_WAKEUP_TOKEN
	linux.epoll_ctl(loop.platform.epoll_fd, .ADD, loop.platform.wakeup_pipe[0], &ev)

	return true
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.use_uring {
		delete(loop.platform.watch_slots)
		loop.platform.watch_slots = nil
		uring.destroy(&loop.platform.ring)
		loop.platform.use_uring = false
	}

	if loop.platform.epoll_fd >= 0 {
		linux.close(loop.platform.epoll_fd)
		loop.platform.epoll_fd = -1
	}

	if loop.platform.wakeup_pipe[0] >= 0 {
		linux.close(loop.platform.wakeup_pipe[0])
		loop.platform.wakeup_pipe[0] = -1
	}
	if loop.platform.wakeup_pipe[1] >= 0 {
		linux.close(loop.platform.wakeup_pipe[1])
		loop.platform.wakeup_pipe[1] = -1
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	// One byte is enough to make the read end readable; coalesced wakeups are
	// drained together. Called from any thread (write() is async-signal-safe and
	// thread-safe); EAGAIN on a full pipe is fine — a wakeup is already pending.
	b := [1]u8{1}
	linux.write(loop.platform.wakeup_pipe[1], b[:])
}

// drain_wakeup empties the wakeup pipe's read end so it is not perpetually
// readable (which would busy-spin the poll). The bytes carry no information.
drain_wakeup :: proc(loop: ^Loop) {
	buf: [64]u8
	for {
		n, err := linux.read(loop.platform.wakeup_pipe[0], buf[:])
		if err != nil || n <= 0 do break
	}
}

platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	fd := linux.Fd(watcher.fd)
	if loop.platform.use_uring {
		events: linux.Fd_Poll_Events = {.IN} if watcher.mode == .Read else {.OUT}
		// Allocate a fresh table slot and arm the poll under its generation token
		// rather than the raw watcher pointer: a completion is now mapped back through
		// the table, so a stale one (after unwatch_fd bumped the generation) is dropped
		// without ever dereferencing the watcher. The loop-level watch_fd wrapper only
		// reaches here for a NOT-yet-watched watcher, so each call is one new slot.
		token := uring_alloc_slot(loop, watcher)
		if arm_uring_poll(loop, u64(watcher.fd), token, events) {
			return true
		}
		// Arm failed (SQ ring full and a submit-to-drain retry inside arm_uring_poll
		// could not free a slot): release the slot so it is not stranded in_use.
		uring_release_slot(loop, uring_token_index(token))
		return false
	}

	ev: linux.EPoll_Event
	ev.events = {.IN} if watcher.mode == .Read else {.OUT}
	ev.data.ptr = watcher

	err := linux.epoll_ctl(loop.platform.epoll_fd, .ADD, fd, &ev)
	return err == nil
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if loop.platform.use_uring {
		// Real cancellation (#183), two layers, both required:
		//   1. ASYNC_CANCEL the outstanding POLL_ADD by its token so the kernel tears
		//      the poll down promptly — nothing lingers armed on a live or about-to-be-
		//      closed fd, and no spurious POLLNVAL completion fires after fd close.
		//   2. Release the table slot, bumping its generation. This is the memory-safe
		//      backstop: ANY completion that still races through (the cancelled poll's
		//      own -ECANCELED, or one already on the CQ before the cancel landed) now
		//      carries a stale token and is dropped in drain_uring_completions WITHOUT
		//      touching the watcher. The watcher (and its owning request) may therefore
		//      be freed as soon as unwatch_fd returns — no deferred-reclaim needed.
		// Returns true unconditionally: the logical `watched` flag in the loop wrapper,
		// not the kernel result, drives active_io_count, and a best-effort cancel that
		// could not get an SQE is still covered by the generation check.
		if index, found := uring_find_slot(loop, watcher); found {
			uring_cancel_poll(loop, uring_encode_token(index, loop.platform.watch_slots[index].generation))
			uring_release_slot(loop, index)
		}
		return true
	}

	fd := linux.Fd(watcher.fd)
	err := linux.epoll_ctl(loop.platform.epoll_fd, .DEL, fd, nil)
	return err == nil
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	if loop.platform.use_uring {
		platform_poll_uring(loop, timeout_ms)
		return
	}

	if loop.platform.epoll_fd < 0 do return

	events: [32]linux.EPoll_Event
	n: int

	// Re-enter on EINTR rather than returning a spurious idle wake: a signal that
	// interrupts the wait must not be mistaken for "nothing to do". For a finite
	// timeout the retry waits the REMAINING time (an absolute deadline), so a storm
	// of signals can neither restart the full interval nor extend it unboundedly.
	poll_start := time.tick_now()
	for {
		res: i32
		errno: linux.Errno
		if timeout_ms < 0 {
			res, errno = linux.epoll_wait(
				loop.platform.epoll_fd,
				raw_data(events[:]),
				i32(len(events)),
				-1,
			)
		} else {
			remaining := poll_remaining_ms(poll_start, timeout_ms)
			ts := linux.Time_Spec {
				time_sec  = uint(remaining / 1000),
				time_nsec = uint((remaining % 1000) * 1_000_000),
			}
			res, errno = linux.epoll_pwait2(
				loop.platform.epoll_fd,
				raw_data(events[:]),
				i32(len(events)),
				&ts,
				nil,
			)
		}

		if errno == .EINTR {
			continue
		}
		// Any other error is fatal (e.g. EBADF on a closed epoll fd): flag it so the
		// run drivers stop instead of busy-spinning on a syscall that can never make
		// progress.
		if errno != nil {
			loop.backend_error = true
			return
		}
		n = int(res)
		break
	}

	if n <= 0 do return

	for i in 0 ..< n {
		ev := events[i]

		if ev.data.u64 == EPOLL_WAKEUP_TOKEN {
			drain_wakeup(loop)
			continue
		}

		// A registered socket / file-descriptor event.
		watcher := cast(^IO_Watcher)ev.data.ptr
		if watcher != nil && watcher.callback != nil {
			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)
		}
	}
}

platform_poll_uring :: proc(loop: ^Loop, timeout_ms: int) {
	if timeout_ms == 0 {
		drain_uring_completions(loop)
		return
	}

	// Bound the wait with the timer deadline via io_uring_enter's EXT_ARG timeout
	// (the same path submit already takes) rather than submitting a separate
	// IORING_OP_TIMEOUT SQE. The kernel arms and tears the timeout down internally,
	// so there is no standalone timeout op left pending after an early wake (a
	// socket completing first) to fire spuriously on a later wait — previously one
	// of the spurious-wake sources behind the premature-exit class (#72).
	ts: linux.Time_Spec
	ts_ptr: ^linux.Time_Spec = nil
	if timeout_ms > 0 {
		ts = linux.Time_Spec {
			time_sec  = uint(timeout_ms / 1000),
			time_nsec = uint((timeout_ms % 1000) * 1_000_000),
		}
		ts_ptr = &ts
	}

	// Wait for at least one completion (timeout_ms < 0 → ts_ptr nil → block until
	// one arrives). A timed-out wait returns -ETIME and an interrupted one -EINTR;
	// both are benign — we just reap whatever completed and let the driver re-enter.
	uring.submit(&loop.platform.ring, 1, ts_ptr)
	drain_uring_completions(loop)
}

drain_uring_completions :: proc(loop: ^Loop) {
	for {
		n, err := uring.copy_cqes(&loop.platform.ring, loop.platform.cqes[:], 0)
		if err != nil || n == 0 do return

		for i in 0 ..< int(n) {
			cqe := loop.platform.cqes[i]

			if cqe.user_data == URING_WAKEUP_USER_DATA {
				drain_wakeup(loop)
				// Re-arm the one-shot poll on the wakeup pipe for the next wakeup. If
				// the SQ ring is momentarily full, submit to free slots and retry once
				// rather than silently dropping the re-arm — otherwise this loop could
				// never be woken across threads again (post_async could not break a
				// parked poll). Mirrors the watcher re-arm below.
				if !arm_uring_poll(
					loop,
					u64(loop.platform.wakeup_pipe[0]),
					URING_WAKEUP_USER_DATA,
					{.IN},
				) {
					uring.submit(&loop.platform.ring, 0, nil)
					arm_uring_poll(
						loop,
						u64(loop.platform.wakeup_pipe[0]),
						URING_WAKEUP_USER_DATA,
						{.IN},
					)
				}
				continue
			}

			// An ASYNC_CANCEL completion issued by unwatch_fd. It carries no watcher
			// work (its target's -ECANCELED is handled as a stale token below); just
			// reap it. -ENOENT/-EALREADY here mean the poll already completed or was
			// already gone — both benign.
			if cqe.user_data == URING_CANCEL_USER_DATA {
				continue
			}

			// A completion from a registered async socket watcher. Map the token back
			// through the table; a stale token (slot released or its generation bumped
			// by unwatch_fd) is dropped WITHOUT dereferencing the watcher, which may
			// already be freed — this is the core stale-poll safety guarantee.
			index := uring_token_index(cqe.user_data)
			gen := uring_token_generation(cqe.user_data)
			if !uring_slot_live(loop, index, gen) do continue

			watcher := loop.platform.watch_slots[index].watcher
			if watcher == nil || watcher.callback == nil do continue

			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)

			// POLL_ADD is one-shot; re-arm only if the slot is STILL the same live
			// watcher after the callback. The callback may have unwatched (releasing
			// the slot), or unwatched then re-watched (a different slot now owns a
			// fresh poll) — re-validating index+generation catches both, so we never
			// re-arm a freed or reassigned slot. A re-watch is left to its own poll.
			if !uring_slot_live(loop, index, gen) do continue
			watcher = loop.platform.watch_slots[index].watcher
			if watcher == nil || watcher.callback == nil do continue

			events: linux.Fd_Poll_Events = {.IN} if watcher.mode == .Read else {.OUT}
			// If the SQ ring is momentarily full, submit to free slots and retry once
			// rather than silently dropping the re-arm (which would strand the fd with
			// no kernel poll).
			if !arm_uring_poll(loop, u64(watcher.fd), cqe.user_data, events) {
				uring.submit(&loop.platform.ring, 0, nil)
				arm_uring_poll(loop, u64(watcher.fd), cqe.user_data, events)
			}
		}
	}
}

arm_uring_poll :: proc(
	loop: ^Loop,
	fd: u64,
	user_data: u64,
	events: linux.Fd_Poll_Events,
) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok do return false

	// Clear any stale state from a prior use of this SQE slot — get_sqe recycles
	// ring entries and does not zero them.
	sqe^ = {}
	sqe.opcode = .POLL_ADD
	sqe.fd = cast(linux.Fd)fd // explicit cast to the distinct linux.Fd type
	sqe.user_data = user_data
	// POLL_ADD reads the interest mask from poll_events; writing it to addr (the
	// previous behavior) left poll_events zero, so the poll never completed.
	sqe.poll_events = events
	// Flush the SQE into the kernel now (non-blocking, wait_nr=0). Submission must
	// not depend on a later platform_poll call: when a due timer keeps the poll
	// phase from running, a re-arm staged but never submitted would strand the fd.
	uring.submit(&loop.platform.ring, 0, nil)
	return true
}

// --- io_uring watcher table + generation tokens (#183) ---
//
// A POLL_ADD's user_data is a token, not a pointer: the low 32 bits are a slot
// index into Platform_Loop.watch_slots and the high 32 bits are that slot's
// generation. Encoding the generation makes every watcher token >= 1<<32, so it
// can never collide with the small reserved sentinels (wakeup = 1, cancel = 2).
uring_encode_token :: proc(index: u32, generation: u32) -> u64 {
	return (u64(generation) << 32) | u64(index)
}

uring_token_index :: proc(token: u64) -> u32 {
	return u32(token & 0xFFFF_FFFF)
}

uring_token_generation :: proc(token: u64) -> u32 {
	return u32(token >> 32)
}

// uring_slot_live reports whether `index` still names an in-use slot at exactly
// `generation`. A false here is the stale-completion signal: the slot was released
// (or reused at a newer generation) by unwatch_fd, so the completion must be
// dropped without touching the watcher it once referenced.
uring_slot_live :: proc(loop: ^Loop, index: u32, generation: u32) -> bool {
	if int(index) >= len(loop.platform.watch_slots) do return false
	slot := loop.platform.watch_slots[index]
	return slot.in_use && slot.generation == generation
}

// uring_alloc_slot reserves a table slot for `watcher` and returns its POLL_ADD
// token. A freed slot is reused before the array grows, so the table stays sized
// to the high-water mark of concurrently watched fds. Generation starts at 1 (and
// skips 0 on wrap) so a token is always >= 1<<32 — never a reserved sentinel.
uring_alloc_slot :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> u64 {
	for i in 0 ..< len(loop.platform.watch_slots) {
		slot := &loop.platform.watch_slots[i]
		if !slot.in_use {
			slot.watcher = watcher
			slot.in_use = true
			if slot.generation == 0 do slot.generation = 1
			return uring_encode_token(u32(i), slot.generation)
		}
	}
	append(&loop.platform.watch_slots, Uring_Watch_Slot{watcher = watcher, generation = 1, in_use = true})
	return uring_encode_token(u32(len(loop.platform.watch_slots) - 1), 1)
}

// uring_find_slot returns the in-use slot index currently holding `watcher`. The
// active set is the small in-flight-fd count, so the linear scan is cheap.
uring_find_slot :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> (index: u32, found: bool) {
	for i in 0 ..< len(loop.platform.watch_slots) {
		slot := loop.platform.watch_slots[i]
		if slot.in_use && slot.watcher == watcher {
			return u32(i), true
		}
	}
	return 0, false
}

// uring_release_slot frees a slot and bumps its generation so any completion still
// in flight for the old token is recognized stale (uring_slot_live → false) and
// dropped. Skipping generation 0 on wrap keeps tokens out of the sentinel range.
uring_release_slot :: proc(loop: ^Loop, index: u32) {
	if int(index) >= len(loop.platform.watch_slots) do return
	slot := &loop.platform.watch_slots[index]
	slot.in_use = false
	slot.watcher = nil
	slot.generation += 1
	if slot.generation == 0 do slot.generation = 1
}

// uring_cancel_poll asks the kernel to cancel the outstanding POLL_ADD identified
// by `target_token`. Best-effort: a failure to obtain an SQE is acceptable because
// the generation bump in uring_release_slot already makes any surviving completion
// safe to drop — the cancel is the promptness optimization, not the safety net.
// The cancel op's own completion carries URING_CANCEL_USER_DATA and is ignored.
uring_cancel_poll :: proc(loop: ^Loop, target_token: u64) {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok {
		// SQ ring momentarily full: submit to free slots, then retry once.
		uring.submit(&loop.platform.ring, 0, nil)
		sqe, ok = uring.get_sqe(&loop.platform.ring)
		if !ok do return
	}
	// Zero the recycled SQE slot — get_sqe does not clear it (mirrors arm_uring_poll).
	sqe^ = {}
	sqe.opcode = .ASYNC_CANCEL
	sqe.addr = target_token // match the POLL_ADD whose user_data == target_token
	sqe.user_data = URING_CANCEL_USER_DATA
	uring.submit(&loop.platform.ring, 0, nil)
}
