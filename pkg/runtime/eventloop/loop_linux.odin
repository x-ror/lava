#+build linux
package eventloop

import "core:mem"
import "core:sys/linux"
import "core:sys/linux/uring"

URING_TIMEOUT_USER_DATA :: u64(0)
URING_EVENTFD_USER_DATA :: u64(1)

Platform_Loop :: struct {
	use_uring: bool,
	ring:      uring.Ring,
	cqes:      [32]linux.IO_Uring_CQE,
	epoll_fd:  linux.Fd,
	event_fd:  linux.Fd,
}

platform_name :: proc(loop: ^Loop) -> string {
	if loop.platform.use_uring {
		return "linux-io_uring"
	}
	return "linux-epoll"
}

platform_init :: proc(loop: ^Loop) -> bool {
	loop.platform.epoll_fd = -1
	loop.platform.event_fd = -1

	evt_fd, evt_err := linux.eventfd(0, {.CLOEXEC, .NONBLOCK})
	if evt_err != nil do return false
	loop.platform.event_fd = evt_fd

	params := uring.DEFAULT_PARAMS
	uring_err := uring.init(&loop.platform.ring, &params, 256)
	if uring_err == nil {
		loop.platform.use_uring = true

		arm_uring_poll(loop, u64(loop.platform.event_fd), URING_EVENTFD_USER_DATA, {.IN})
		return true
	}

	fd, err := linux.epoll_create1({.FDCLOEXEC})
	if err != nil {
		linux.close(loop.platform.event_fd)
		return false
	}
	loop.platform.epoll_fd = fd

	ev: linux.EPoll_Event
	ev.events = {.IN}
	ev.data.fd = loop.platform.event_fd // Виправлено: обидва поля мають тип linux.Fd
	linux.epoll_ctl(loop.platform.epoll_fd, .ADD, loop.platform.event_fd, &ev)

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

	if loop.platform.event_fd >= 0 {
		linux.close(loop.platform.event_fd)
		loop.platform.event_fd = -1
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	val: u64 = 1
	buf := mem.ptr_to_bytes(&val, size_of(val))
	linux.write(loop.platform.event_fd, buf)
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

		if ev.data.fd == loop.platform.event_fd {
			val: u64
			buf := mem.ptr_to_bytes(&val, size_of(val))
			linux.read(loop.platform.event_fd, buf)
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

			if cqe.user_data == URING_EVENTFD_USER_DATA {
				val: u64
				buf := mem.ptr_to_bytes(&val, size_of(val))
				linux.read(loop.platform.event_fd, buf)
				// Перевикликаємо poll для eventfd на наступну ітерацію лупу
				arm_uring_poll(loop, u64(loop.platform.event_fd), URING_EVENTFD_USER_DATA, {.IN})
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
