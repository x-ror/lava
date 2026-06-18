#+build !linux
#+build !darwin
#+build !windows
package lava_runtime

// Fallback for platforms with no fetch transport at all. Linux, Darwin, and
// Windows use fetch_transport.odin + their platform primitives over OpenSSL
// (http:// and https://). Everything else rejects the network call here, while the
// Headers/Request/Response surface still works. The TLS reject stubs (including
// fetch_tls_cleanup) live in fetch_tls_stub.odin, which now covers only these
// transport-less platforms.

fetch_close_fd :: proc(fd: uintptr) {}

fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	return false, "fetch: HTTP transport is not implemented on this platform"
}

// Streaming request-body entry points (called from the all-platform fetch.odin).
// No transport exists here — a streamed request never gets past
// fetch_transport_start — so these remain defensive no-ops.
fetch_push_body :: proc(req: ^Fetch_Request, data: []byte) {}

fetch_end_body :: proc(req: ^Fetch_Request) {}

// fetch_dns_pool_shutdown is called from the all-platform teardown in fetch.odin.
// There is no DNS pool without a transport (fetch_dns_pool.odin builds only on
// linux/darwin/windows), so this is a no-op here.
fetch_dns_pool_shutdown :: proc() {}
