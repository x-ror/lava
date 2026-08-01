#+build windows
package lava_runtime

import "core:os"

// Retry classification for the locked stdout/stderr writer, Windows half.
//
// An honest stub rather than a silent one, per CLAUDE.md §4. Windows has no EAGAIN/EINTR
// on a console or pipe handle — `WriteFile` blocks or fails outright — so there is no
// retryable case to report, and returning false here is the true answer, not a
// placeholder. The write loop in globals.odin still re-slices on a SHORT write, which is
// the part that is real on every platform.
stdio_retryable :: proc(err: os.Error) -> bool {
	return false
}

// stdio_wait_writable is a no-op on Windows: stdio_retryable never reports a retryable
// error there, so process_write_all cannot reach this. Present so the writer compiles
// without a `when ODIN_OS` at the call site.
stdio_wait_writable :: proc(fd: ^os.File) {
}
