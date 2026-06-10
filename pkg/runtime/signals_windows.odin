#+build windows
package lava_runtime

// Windows has no SIGPIPE: a write to a closed socket/pipe already fails with
// an error instead of raising a process-killing signal. No-op for API parity
// with signals_posix.odin.
ignore_sigpipe :: proc() {
}
