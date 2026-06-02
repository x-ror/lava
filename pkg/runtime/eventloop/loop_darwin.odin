#+build darwin
package eventloop

import "core:sys/kqueue"
import "core:sys/posix"

Platform_Loop :: struct {
	kq:          kqueue.KQ,
	wakeup_pipe: [2]posix.FD,
}

platform_name :: proc(loop: ^Loop) -> string {
	return "darwin-kqueue"
}

platform_init :: proc(loop: ^Loop) -> bool {
	kq, kq_err := kqueue.kqueue()
	if kq_err != .NONE {
		return false
	}
	loop.platform.kq = kq

	if posix.pipe(&loop.platform.wakeup_pipe) != .OK {
		posix.close(loop.platform.kq)
		return false
	}

	posix.fcntl(loop.platform.wakeup_pipe[0], .SETFL, posix.O_Flags{.NONBLOCK})

	ev := kqueue.KEvent {
		ident  = uintptr(loop.platform.wakeup_pipe[0]),
		filter = .Read,
		flags  = {.Add, .Enable},
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	if err != .NONE {
		posix.close(loop.platform.wakeup_pipe[0])
		posix.close(loop.platform.wakeup_pipe[1])
		posix.close(loop.platform.kq)
		return false
	}

	return true
}

platform_destroy :: proc(loop: ^Loop) {
	posix.close(loop.platform.wakeup_pipe[0])
	posix.close(loop.platform.wakeup_pipe[1])
	posix.close(loop.platform.kq)
}

platform_wakeup :: proc(loop: ^Loop) {
	dummy: byte = 1
	posix.write(loop.platform.wakeup_pipe[1], &dummy, 1)
}

platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	ev := kqueue.KEvent {
		ident  = watcher.fd,
		filter = .Read if watcher.mode == .Read else .Write,
		flags  = {.Add, .Enable},
		udata  = watcher,
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	return err == .NONE
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	ev := kqueue.KEvent {
		ident  = watcher.fd,
		filter = .Read if watcher.mode == .Read else .Write,
		flags  = {.Delete},
	}
	_, err := kqueue.kevent(loop.platform.kq, {ev}, nil, nil)
	return err == .NONE
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	events: [32]kqueue.KEvent

	ts: posix.timespec
	timeout: ^posix.timespec = nil
	if timeout_ms >= 0 {
		ts.tv_sec = posix.time_t(timeout_ms / 1000)
		ts.tv_nsec = i64((timeout_ms % 1000) * 1_000_000)
		timeout = &ts
	}

	n, _ := kqueue.kevent(loop.platform.kq, nil, events[:], timeout)
	if n == 0 {
		return
	}

	for i in 0 ..< n {
		ev := events[i]

		if ev.ident == uintptr(loop.platform.wakeup_pipe[0]) {
			buf: [64]byte
			for posix.read(loop.platform.wakeup_pipe[0], &buf[0], len(buf)) > 0 {}
			continue
		}

		watcher := cast(^IO_Watcher)ev.udata
		if watcher != nil && watcher.callback != nil {
			watcher.callback(loop, watcher.user_data)
		}
	}
}
