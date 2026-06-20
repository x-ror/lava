#+build darwin, windows
package lava_runtime

// Linux-first stub: TTY detection is not implemented on darwin/windows yet, so isatty
// reports false there. The Linux implementation lives in tty_linux.odin.
tty_fd_isatty :: proc(fd: int) -> bool {
	return false
}
