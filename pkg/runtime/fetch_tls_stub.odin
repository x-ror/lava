#+build !linux
#+build !darwin
#+build !windows
package lava_runtime

import eventloop "lava:pkg/runtime/eventloop"

// Reject stub for the fetch TLS backend on platforms with no OpenSSL link and no
// fetch transport at all (everything outside Linux/Darwin/Windows). Those three
// use the real OpenSSL backend in fetch_tls.odin; here an https:// request is
// rejected up front by fetch_transport_start (fetch_tls_supported == false) and
// never reaches these procs, which remain a defensive backstop only.

// fetch_tls_supported lets the shared transport reject https:// up front (before
// DNS/connect). False here — there is no TLS, so https never reaches the procs
// below; they remain as a defensive backstop only.
fetch_tls_supported :: false

// FETCH_HTTPS_UNSUPPORTED_MSG is the rejection message. Defined in both TLS
// backends so the transport can name it on every target (see fetch_tls.odin).
FETCH_HTTPS_UNSUPPORTED_MSG :: "fetch: HTTPS is not yet supported on this platform"

fetch_tls_cleanup :: proc(req: ^Fetch_Request) {
	// No SSL session is ever created here, so there is nothing to free.
}

fetch_tls_start_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, FETCH_HTTPS_UNSUPPORTED_MSG)
}

fetch_tls_handshake :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, FETCH_HTTPS_UNSUPPORTED_MSG)
}

fetch_tls_write :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, FETCH_HTTPS_UNSUPPORTED_MSG)
}

fetch_tls_read :: proc(loop: ^eventloop.Loop, req: ^Fetch_Request) {
	fetch_settle_error(req, FETCH_HTTPS_UNSUPPORTED_MSG)
}
