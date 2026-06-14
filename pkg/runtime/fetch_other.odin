#+build !linux
#+build !darwin
package lava_runtime

// Fallback for platforms without a fetch transport (currently Windows — the
// event-loop readiness backend works there now via select (#101), but the Windows
// Winsock fetch transport itself is not yet wired up, see #32). The
// Headers/Request/Response surface still works everywhere; only the network call
// rejects. Linux and Darwin use fetch_transport.odin + their platform primitives.

fetch_close_fd :: proc(fd: uintptr) {}

fetch_tls_cleanup :: proc(req: ^Fetch_Request) {}

fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	return false, "fetch: HTTP transport is not implemented on this platform"
}
