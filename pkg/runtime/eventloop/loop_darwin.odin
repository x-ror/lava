#+build darwin
package eventloop

import "core:sys/posix"

Platform_Loop :: struct {
    kq:          posix.FD,
    wakeup_pipe: [2]posix.FD, // wakeup_pipe[0] = read, wakeup_pipe[1] = write
}

platform_name :: proc(loop: ^Loop) -> string {
    return "darwin-kqueue"
}

platform_init :: proc(loop: ^Loop) -> bool {
    // 1. Create the system kernel queue
    loop.platform.kq = posix.kqueue()
    if loop.platform.kq < 0 do return false

    // 2. Create a self-pipe for cross-thread wakeups
    if posix.pipe(&loop.platform.wakeup_pipe) != 0 {
        posix.close(loop.platform.kq)
        return false
    }

    // 3. Set the read end of the pipe to non-blocking mode
    posix.fcntl(loop.platform.wakeup_pipe[0], posix.F_SETFL, posix.O_NONBLOCK)

    // 4. Register the pipe's read-end with kqueue
    ev: posix.kevent_t
    ev.ident  = cast(uintptr)loop.platform.wakeup_pipe[0]
    ev.filter = posix.EVFILT_READ
    ev.flags  = posix.EV_ADD | posix.EV_ENABLE
    
    change_count := posix.kevent(loop.platform.kq, &ev, 1, nil, 0, nil)
    if change_count < 0 {
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
    ev: posix.kevent_t
    ev.ident  = cast(uintptr)watcher.fd
    ev.filter = posix.EVFILT_READ if watcher.mode == .Read else posix.EVFILT_WRITE
    ev.flags  = posix.EV_ADD | posix.EV_ENABLE
    ev.udata  = watcher // Link the entire watcher context directly to the event descriptor

    n := posix.kevent(loop.platform.kq, &ev, 1, nil, 0, nil)
    return n >= 0
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
    ev: posix.kevent_t
    ev.ident  = cast(uintptr)watcher.fd
    ev.filter = posix.EVFILT_READ if watcher.mode == .Read else posix.EVFILT_WRITE
    ev.flags  = posix.EV_DELETE

    n := posix.kevent(loop.platform.kq, &ev, 1, nil, 0, nil)
    return n >= 0
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
    events: [32]posix.kevent_t
    ts: posix.timespec
    
    timeout: ^posix.timespec = nil
    if timeout_ms >= 0 {
        ts.tv_sec = timeout_ms / 1000
        ts.tv_nsec = (timeout_ms % 1000) * 1_000_000
        timeout = &ts
    }

    n := posix.kevent(loop.platform.kq, nil, 0, &events[0], 32, timeout)
    if n <= 0 do return

    for i in 0..<n {
        ev := events[i]
        
        if ev.ident == cast(uintptr)loop.platform.wakeup_pipe[0] {
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