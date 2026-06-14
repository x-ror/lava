#+build !linux
#+build !darwin
#+build !windows
package lava_runtime

// Fallback for platforms with no fetch transport at all. Linux and Darwin use
// fetch_transport.odin + their platform primitives over OpenSSL; Windows uses
// fetch_transport.odin + fetch_windows.odin (plaintext HTTP; HTTPS deferred, see
// #32). Everything else rejects the network call here, while the
// Headers/Request/Response surface still works. The TLS reject stubs (including
// fetch_tls_cleanup) live in fetch_tls_stub.odin, shared with Windows.

fetch_close_fd :: proc(fd: uintptr) {}

fetch_transport_start :: proc(req: ^Fetch_Request, host: string, port: int) -> (ok: bool, err: string) {
	return false, "fetch: HTTP transport is not implemented on this platform"
}
