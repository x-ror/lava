#+build linux, darwin
package lava_runtime

// Platform TLS root policy for Linux/macOS: a no-op. OpenSSL's
// SSL_CTX_set_default_verify_paths (called in tls_client_ctx) already loads the
// platform's system CA set on these targets, so there is nothing extra to inject.
// The Windows counterpart (tls_roots_windows.odin) loads the native cert store.
// See tls.odin and #153.

tls_load_platform_roots :: proc(ctx: SSL_CTX) {
	// Intentionally empty — system roots come from the OpenSSL default paths.
}
