#+build linux, darwin
package lava_runtime

import "core:os"
import "core:sys/posix"

// Retry classification for the locked stdout/stderr writer, POSIX half.
//
// This is split by platform for a front-end reason, not a taste one: `os.Platform_Error`
// is `linux.Errno` on Linux and `posix.Errno` on darwin, but `win32.System_Error` on
// Windows, which has no EAGAIN/EINTR members at all — so a single `#partial switch` over
// them fails the windows_amd64 check `make check` runs. Same split as
// fs_fd_posix.odin / fs_fd_windows.odin.

// stdio_retryable reports whether a failed write should be retried rather than abandoned.
//
// EINTR is a signal arriving mid-write and carries no information about the fd. EAGAIN is
// the one that loses data in practice: nothing in Lava sets O_NONBLOCK on fd 1/2, so it
// arrives INHERITED — a parent (process manager, editor task runner, CI harness) hands the
// child a non-blocking pipe and every write past the first buffer-full fails. Treating
// either as fatal is what silently truncated output to exactly one pipe buffer.
stdio_retryable :: proc(err: os.Error) -> bool {
	perr, ok := err.(os.Platform_Error)
	if !ok do return false
	#partial switch posix.Errno(perr) {
	case .EAGAIN, .EINTR:
		return true
	}
	return false
}

// stdio_wait_writable blocks until `fd` accepts more bytes, so the EAGAIN retry in
// process_write_all waits instead of spinning on a full pipe. A poll error (or a
// hangup) simply returns: the caller retries the write, which then reports the real
// error rather than looping here forever.
stdio_wait_writable :: proc(fd: ^os.File) {
	pfd := posix.pollfd {
		fd     = posix.FD(os.fd(fd)),
		events = {.OUT},
	}
	fds := []posix.pollfd{pfd}
	posix.poll(raw_data(fds), 1, -1)
}
