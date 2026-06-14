#+build linux
package lava_runtime

import "core:c"
import "core:net"
import "core:strings"

// Minimal OpenSSL client bindings for the Linux fetch HTTPS transport. We link
// the system libssl/libcrypto (the same `system:` convention used for sqlite3
// and javascriptcoregtk) and bind only the handful of client-side symbols the
// non-blocking handshake/read/write needs. TLS records replace raw socket bytes
// in fetch_linux.odin; everything else (HTTP framing, the event loop) is shared
// with the plaintext path.
//
// Non-blocking model: the socket is the same O_NONBLOCK fd the plaintext path
// uses. SSL_connect/SSL_read/SSL_write return <= 0 with SSL_get_error reporting
// WANT_READ / WANT_WRITE; the caller re-arms the loop watcher for that direction
// and resumes when the fd is ready again.

// libssl provides the SSL_*/SSL_CTX_* symbols; libcrypto provides the X509
// verification-parameter helpers (e.g. X509_VERIFY_PARAM_set1_ip_asc). Both must
// be on the link line, so import them as a group.
foreign import openssl_lib {
	"system:ssl",
	"system:crypto",
}

SSL_CTX :: distinct rawptr
SSL :: distinct rawptr
SSL_METHOD :: distinct rawptr
X509_VERIFY_PARAM :: distinct rawptr

// SSL_get_error result codes (openssl/ssl.h) that the transport acts on.
SSL_ERROR_WANT_READ :: 2
SSL_ERROR_WANT_WRITE :: 3
SSL_ERROR_SYSCALL :: 5
SSL_ERROR_ZERO_RETURN :: 6

SSL_VERIFY_PEER :: 0x01

// Values for the SSL_ctrl / SSL_CTX_ctrl macros we bind directly.
SSL_CTRL_SET_TLSEXT_HOSTNAME :: 55
SSL_CTRL_SET_MIN_PROTO_VERSION :: 123
TLSEXT_NAMETYPE_host_name :: 0
TLS1_2_VERSION :: 0x0303

@(default_calling_convention = "c")
foreign openssl_lib {
	TLS_client_method :: proc() -> SSL_METHOD ---
	SSL_CTX_new :: proc(method: SSL_METHOD) -> SSL_CTX ---
	SSL_CTX_free :: proc(ctx: SSL_CTX) ---
	SSL_CTX_set_default_verify_paths :: proc(ctx: SSL_CTX) -> c.int ---
	SSL_CTX_set_verify :: proc(ctx: SSL_CTX, mode: c.int, callback: rawptr) ---
	SSL_CTX_ctrl :: proc(ctx: SSL_CTX, cmd: c.int, larg: c.long, parg: rawptr) -> c.long ---

	SSL_new :: proc(ctx: SSL_CTX) -> SSL ---
	SSL_free :: proc(ssl: SSL) ---
	SSL_set_fd :: proc(ssl: SSL, fd: c.int) -> c.int ---
	SSL_set1_host :: proc(ssl: SSL, hostname: cstring) -> c.int ---
	SSL_get0_param :: proc(ssl: SSL) -> X509_VERIFY_PARAM ---
	X509_VERIFY_PARAM_set1_ip_asc :: proc(param: X509_VERIFY_PARAM, ipasc: cstring) -> c.int ---
	SSL_ctrl :: proc(ssl: SSL, cmd: c.int, larg: c.long, parg: rawptr) -> c.long ---
	SSL_connect :: proc(ssl: SSL) -> c.int ---
	SSL_read :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_write :: proc(ssl: SSL, buf: rawptr, num: c.int) -> c.int ---
	SSL_get_error :: proc(ssl: SSL, ret: c.int) -> c.int ---
}

// g_tls_ctx is a process-wide client context, created lazily on the first
// https:// fetch. SSL_CTX is reference-counted and safe to share across the
// SSL_new of every request; OpenSSL 1.1+ self-initialises on first use, so no
// explicit library init call is needed. It is never freed — it lives for the
// process, like g_fetch_cancel_class.
@(private = "file")
g_tls_ctx: SSL_CTX

// tls_client_ctx returns the shared client SSL_CTX, building it on first use:
// system trust store for verification, peer verification on (so a bad cert
// fails the handshake), and a TLS 1.2 floor. Returns nil if the context could
// not be created. set_default_verify_paths honours the SSL_CERT_FILE /
// SSL_CERT_DIR environment variables, which the HTTPS smoke test uses to trust
// its self-signed CA.
tls_client_ctx :: proc() -> SSL_CTX {
	if g_tls_ctx == nil {
		method := TLS_client_method()
		if method == nil do return nil
		ctx := SSL_CTX_new(method)
		if ctx == nil do return nil
		// Fail closed if the trust store can't be loaded (verification would have
		// nothing to check against) or the TLS 1.2 floor can't be set. Both return
		// 1 on success; SSL_CTX_ctrl(SET_MIN_PROTO_VERSION) returns 1 likewise.
		if SSL_CTX_set_default_verify_paths(ctx) != 1 ||
		   SSL_CTX_ctrl(ctx, SSL_CTRL_SET_MIN_PROTO_VERSION, TLS1_2_VERSION, nil) != 1 {
			SSL_CTX_free(ctx)
			return nil
		}
		SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nil)
		g_tls_ctx = ctx
	}
	return g_tls_ctx
}

// tls_new_client builds a per-request SSL bound to the connected socket `fd`,
// with SNI and certificate hostname verification set to `host`. Returns nil on
// any setup failure. The returned SSL must be freed with SSL_free (see
// fetch_tls_cleanup).
tls_new_client :: proc(fd: uintptr, host: string) -> SSL {
	ctx := tls_client_ctx()
	if ctx == nil do return nil
	ssl := SSL_new(ctx)
	if ssl == nil do return nil
	if SSL_set_fd(ssl, c.int(fd)) != 1 {
		SSL_free(ssl)
		return nil
	}
	// Verification needs a NUL-terminated host. OpenSSL copies it into its own
	// storage, so a temp-allocator cstring scoped to this proc is sufficient.
	chost, clone_err := strings.clone_to_cstring(host, context.temp_allocator)
	if clone_err != nil {
		SSL_free(ssl)
		return nil
	}
	// An IP-literal host verifies against the certificate's iPAddress SAN (not a
	// DNS name) and must NOT be sent as SNI (RFC 6066 forbids IP literals there).
	// A DNS name uses SNI + DNS-name verification. Fail closed: if any of these
	// setup calls fails we must not proceed with weaker (or no) verification.
	if tls_host_is_ip(host) {
		if X509_VERIFY_PARAM_set1_ip_asc(SSL_get0_param(ssl), chost) != 1 {
			SSL_free(ssl)
			return nil
		}
	} else {
		// SSL_ctrl returns 1 on a successful SET_TLSEXT_HOSTNAME.
		if SSL_ctrl(ssl, SSL_CTRL_SET_TLSEXT_HOSTNAME, TLSEXT_NAMETYPE_host_name, rawptr(chost)) != 1 {
			SSL_free(ssl)
			return nil
		}
		if SSL_set1_host(ssl, chost) != 1 {
			SSL_free(ssl)
			return nil
		}
	}
	return ssl
}

// tls_host_is_ip reports whether host is an IPv4 or IPv6 literal (so it should
// be verified as an IP address rather than a DNS name). The transport delivers
// IPv6 literals bracket-stripped (e.g. "::1"), matching net.parse_ip6_address.
tls_host_is_ip :: proc(host: string) -> bool {
	if _, ok := net.parse_ip4_address(host); ok do return true
	if _, ok := net.parse_ip6_address(host); ok do return true
	return false
}
