#+build linux, darwin
package lava_runtime

import "core:sys/posix"

// ignore_sigpipe sets SIGPIPE to SIG_IGN process-wide, matching Node: a write
// to a closed socket or pipe (a fetch peer resetting mid-request, or stdout
// piped into a consumer that exited, e.g. `lava run app.js | head -1`) must
// surface as an EPIPE write error, not terminate the process via the default
// SIGPIPE disposition. Socket sends additionally pass MSG_NOSIGNAL where the
// platform supports it; this covers every other fd. Idempotent.
ignore_sigpipe :: proc() {
	posix.signal(.SIGPIPE, cast(proc "c" (posix.Signal))posix.SIG_IGN)
}
