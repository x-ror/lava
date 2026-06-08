#+build linux
package eventloop

import "core:sys/linux"
import "core:sys/linux/uring"

URING_TIMEOUT_USER_DATA :: u64(0)
URING_WAKEUP_USER_DATA :: u64(1)

Platform_Loop :: struct {
	use_uring:   bool,
	ring:        uring.Ring,
	cqes:        [32]linux.IO_Uring_CQE,
	epoll_fd:    linux.Fd,
	// Self-pipe used by wakeup() to kick the loop out of poll from another thread.
	// A pipe (not an eventfd): io_uring POLL_ADD reliably completes on a pipe fd
	// but not on an eventfd in our kernels (#74). [0] = read end, [1] = write end.
	wakeup_pipe: [2]linux.Fd,
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
	ev.data.fd = loop.platform.wakeup_pipe[0]
	linux.epoll_ctl(loop.platform.epoll_fd, .ADD, loop.platform.wakeup_pipe[0], &ev)

	return true
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.use_uring {
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
		return arm_uring_poll(loop, u64(watcher.fd), u64(uintptr(watcher)), events)
	}

	ev: linux.EPoll_Event
	ev.events = {.IN} if watcher.mode == .Read else {.OUT}
	ev.data.ptr = watcher

	err := linux.epoll_ctl(loop.platform.epoll_fd, .ADD, fd, &ev)
	return err == nil
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	if loop.platform.use_uring {
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

	if timeout_ms < 0 {
		// Виправлено: передаємо raw_data(events), довжину як i32, та кастимо результат n_res
		n_res, _ := linux.epoll_wait(
			loop.platform.epoll_fd,
			raw_data(events[:]),
			i32(len(events)),
			-1,
		)
		n = int(n_res)
	} else {
		ts := linux.Time_Spec {
			time_sec  = uint(timeout_ms / 1000),
			time_nsec = uint((timeout_ms % 1000) * 1_000_000),
		}
		// Виправлено: додано пропущений аргумент i32(len(events)) (maxevents) та raw_data(events)
		n_res, _ := linux.epoll_pwait2(
			loop.platform.epoll_fd,
			raw_data(events[:]),
			i32(len(events)),
			&ts,
			nil,
		)
		n = int(n_res)
	}

	if n <= 0 do return

	for i in 0 ..< n {
		ev := events[i]

		if ev.data.fd == loop.platform.wakeup_pipe[0] {
			drain_wakeup(loop)
			continue
		}

		// Обробка мережевого сокету / дескриптора файлу
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

	if timeout_ms > 0 {
		ts := linux.Time_Spec {
			time_sec  = uint(timeout_ms / 1000),
			time_nsec = uint((timeout_ms % 1000) * 1_000_000),
		}
		_, ok := uring.timeout(&loop.platform.ring, URING_TIMEOUT_USER_DATA, &ts, 0, {})
		if !ok {
			drain_uring_completions(loop)
			return
		}
	}

	// Очікуємо на завершення хоча б однієї події в черзі ядра
	uring.submit(&loop.platform.ring, 1, nil)
	drain_uring_completions(loop)
}

drain_uring_completions :: proc(loop: ^Loop) {
	for {
		n, err := uring.copy_cqes(&loop.platform.ring, loop.platform.cqes[:], 0)
		if err != nil || n == 0 do return

		for i in 0 ..< int(n) {
			cqe := loop.platform.cqes[i]

			if cqe.user_data == URING_TIMEOUT_USER_DATA {
				continue
			}

			if cqe.user_data == URING_WAKEUP_USER_DATA {
				drain_wakeup(loop)
				// Re-arm the one-shot poll on the wakeup pipe for the next wakeup.
				arm_uring_poll(loop, u64(loop.platform.wakeup_pipe[0]), URING_WAKEUP_USER_DATA, {.IN})
				continue
			}

			// Подія від зареєстрованого асинхронного вочера сокетів
			watcher := cast(^IO_Watcher)uintptr(cqe.user_data)
			if watcher != nil && watcher.callback != nil {
				loop.io_events += 1
				watcher.callback(loop, watcher.user_data)

				// The callback may have torn the watcher down (callback cleared)
				// when the request finished; only re-arm if it is still active.
				if watcher.callback != nil {
					events: linux.Fd_Poll_Events = {.IN} if watcher.mode == .Read else {.OUT}
					// If the SQ ring is momentarily full, submit to free slots and
					// retry once rather than silently dropping the re-arm (which
					// would strand the fd with no kernel poll).
					if !arm_uring_poll(loop, u64(watcher.fd), cqe.user_data, events) {
						uring.submit(&loop.platform.ring, 0, nil)
						arm_uring_poll(loop, u64(watcher.fd), cqe.user_data, events)
					}
				}
			}
		}
	}
}

arm_uring_poll :: proc(loop: ^Loop, fd: u64, user_data: u64, events: linux.Fd_Poll_Events) -> bool {
	sqe, ok := uring.get_sqe(&loop.platform.ring)
	if !ok do return false

	// Clear any stale state from a prior use of this SQE slot — get_sqe recycles
	// ring entries and does not zero them.
	sqe^ = {}
	sqe.opcode = .POLL_ADD
	sqe.fd = cast(linux.Fd)fd // явний cast до distinct типу linux.Fd
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
