#+build linux
package lava_runtime

import "core:sys/posix"

// tty_fd_isatty reports whether fd refers to a terminal (Linux). darwin and windows are
// stubbed in tty_other.odin per the project's Linux-first direction.
tty_fd_isatty :: proc(fd: int) -> bool {
	return bool(posix.isatty(posix.FD(fd)))
}
