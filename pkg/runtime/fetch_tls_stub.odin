#+build !linux
#+build !darwin
package lava_runtime

import eventloop "lava:pkg/runtime/eventloop"

// Reject stub for the fetch TLS backend on platforms where OpenSSL is not yet
// wired up (currently Windows — plaintext HTTP works via fetch_windows.odin, but
// HTTPS is deferred until OpenSSL is linked there, see #32). Plaintext fetch never
// reaches these procs; an https:// request settles cleanly with the message below
// instead of connecting. The real OpenSSL backend lives in fetch_tls.odin.

HTTPS_UNSUPPORTED :: "fetch: HTTPS is not yet supported on this platform"

fetch_tls_cleanup :: proc(req: ^Fetch_Request) {
	// No SSL session is ever created here, so there is nothing to free.
}

fetch_tls_start_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, HTTPS_UNSUPPORTED)
}

fetch_tls_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, HTTPS_UNSUPPORTED)
}

fetch_tls_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, HTTPS_UNSUPPORTED)
}

fetch_tls_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, HTTPS_UNSUPPORTED)
}
