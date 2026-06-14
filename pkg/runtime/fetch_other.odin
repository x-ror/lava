#+build !linux
#+build !darwin
package lava_runtime

// Fallback for platforms without a fetch transport (currently Windows — its
// event-loop watch_fd is a non-functional readiness stub, see #101). The
// Headers/Request/Response surface still works everywhere; only the network call
// rejects. Linux and Darwin use fetch_transport.odin + their platform primitives.

fetch_close_fd :: proc(fd: uintptr) {}

fetch_tls_cleanup :: proc(req: ^Fetch_Request) {}

fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	return false, "fetch: HTTP transport is not implemented on this platform"
}
