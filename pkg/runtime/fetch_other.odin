#+build !linux
package lava_runtime

// Non-Linux fallback for the fetch transport. The Headers/Request/Response
// surface still works everywhere; only the network call rejects. Darwin
// (kqueue) and Windows (IOCP) transports are future work.

fetch_close_fd :: proc(fd: uintptr) {}

fetch_tls_cleanup :: proc(req: ^Fetch_Request) {}

fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	return false, "fetch: HTTP transport is only implemented on Linux in this build"
}
