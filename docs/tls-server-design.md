# TLS / HTTPS server design — review before implementation

Status: **DESIGN — review before impl.** Adds a TLS *server* (`https.createServer`) to lava. lava already
has a TLS *client* (fetch over https); this is the server-side counterpart. Grounded in a 4-agent recon of
`net.odin`, `net.js`, `http.js`, `tls.odin`, `fetch_tls.odin`, `tls_darwin.odin`.

## 1. Goal & scope

**M1 (this slice):** `https.createServer(options, requestListener)` where `options = { key, cert }` (PEM
strings/Buffers, as Node passes them). It returns an `http.Server` whose connections are TLS-wrapped; the
existing `node:http` request/response machinery runs **unchanged** over the decrypted socket. Both proactor
and readiness backends supported.

**Explicitly deferred** (M2+): `tls.createServer` (bare TLS, non-HTTP) + `TLSSocket`; client-cert auth
(`requestCert`/`ca`/`rejectUnauthorized`); SNI (`SNICallback`, multi-cert); ALPN; session resumption
(tickets/IDs); `passphrase` (encrypted keys); `minVersion`/`maxVersion` tuning; cert hot-reload; TLS 1.3
0-RTT. M1 ships one cert+key, TLS 1.2+ (1.3 if the linked OpenSSL supports it), no client verification —
mirroring how `node:http` shipped as "M2" with a deliberately minimal surface.

**Deferred-but-security-sensitive options must be REJECTED, not silently ignored** (Codex P2-§17): if a
caller passes `requestCert`, `ca`, `rejectUnauthorized`, `minVersion`, `maxVersion`, `ciphers`,
`passphrase`, `SNICallback`, or `ALPNProtocols`, `https.createServer` **throws** (`ERR_TLS_*`-shaped) rather
than treating them as the M1 no-client-auth / TLS-1.2-floor default — silently ignoring e.g.
`rejectUnauthorized:true` or `minVersion:'TLSv1.3'` would give the caller weaker security than they
explicitly requested.

## 2. The load-bearing decision: memory-BIO, not `SSL_set_fd`

The fetch **client** binds the socket fd into OpenSSL (`SSL_set_fd`) and lets libssl do the `read()/write()`
syscalls, re-arming the readiness watcher on `WANT_READ/WANT_WRITE`. **A server on the io_uring proactor
cannot do this** — the proactor owns the socket: a `RECV` op completes with *ciphertext bytes in a buffer*,
not socket readiness, and `SSL_read`/`SSL_write` must run synchronously on the loop thread without touching
the fd.

So the server gives each connection an SSL object backed by **two `BIO_s_mem` memory BIOs**, decoupling SSL
from the fd entirely:

```
            recv ciphertext (RECV completion, recv_buf)
                 │ BIO_write(rbio, recv_buf, n)
                 ▼
   rbio ──► [ SSL_read ] ──► plaintext ──► on_data → http.js
                 ▲
   wbio ◄── [ SSL_write ] ◄── plaintext ◄── socket.write() (http.js response)
                 │ BIO_read(wbio, buf, n)
                 ▼
            send ciphertext (active_send / pending_writes → SEND op)
```

The app is the only mover of bytes between the socket and the BIOs; OpenSSL only ever touches the BIOs.
This is the standard OpenSSL pattern for async/completion-mode servers. (Rejected alternative: custom I/O
callbacks like the Darwin SecureTransport client — viable, but memory BIOs are more OpenSSL-native,
self-contained, and better documented.)

## 3. Where TLS slots in: the native socket seam (http.js stays TLS-agnostic)

`http.Server` wraps `net.Server` and only ever does `socket.on('data', …)` + `socket.write(…)`. If the
socket **emits decrypted plaintext** and **encrypts on write**, HTTP runs unchanged — keep-alive, chunked,
timeouts, the whole `onConnection` loop. So TLS is wrapped at the **native `net.odin` layer**, NOT in
`http.js` and NOT as a JS `TLSSocket` wrapper:

- **`net_accept_cb`** — if the listener is TLS, allocate the per-conn SSL + rbio/wbio and enter a
  `.TLS_Handshake` phase *before* any `'data'` is emitted.
- **recv completion** (`on_recv_complete` / `net_recv_ring_complete` / readiness `conn_read_cb`) — feed
  ciphertext to rbio, drive the handshake or `SSL_read`-decrypt loop, emit plaintext via `on_data`.
- **write** (`net_write_cb` → `net_proactor_submit` / readiness `net_flush`) — `SSL_write` the plaintext,
  drain wbio ciphertext into the existing send buffers.
- **close** — a new `.TLS_Closing` phase (§6e) sends close_notify *before* the existing hard teardown.
- On a TLS conn, the native side sets **`socket.encrypted = true`** (Codex P2-§156) so HTTPS middleware that
  checks `req.socket.encrypted` (secure-cookie, redirect-to-https, `req.secure`) classifies the request
  correctly — even though full `TLSSocket` is deferred.

http.js's **request/response machinery is unchanged**, but the claim of "zero changes" is too strong (Codex
P2-§64): `http.Server` builds `this._net = net.createServer(...)` internally and only consumes `options` for
timeouts, so it needs a **small hook** to forward a `tls` option through to the `net` listener. `https.js`
calls `http.createServer(opts, listener)` with the TLS context attached; `http.Server.listen` threads that
context to `net.createServer`/`listen`. No change to the parser, `IncomingMessage`/`ServerResponse`, or the
`onConnection` loop.

## 4. New OpenSSL bindings (add to `tls.odin`; libssl/libcrypto already linked)

Server method + handshake + shutdown: `TLS_server_method`, `SSL_accept`, `SSL_shutdown`,
`SSL_set_accept_state`.
Memory BIOs: `BIO_new` + `BIO_s_mem`, `BIO_write`, `BIO_read`, `BIO_new_mem_buf`, `SSL_set0_rbio`,
`SSL_set0_wbio` (BIO ownership transfers to the SSL; freed by `SSL_free`).
PEM load from memory (Node passes PEM *content*, not paths): `PEM_read_bio_X509`,
`PEM_read_bio_PrivateKey`, `SSL_CTX_use_certificate`, `SSL_CTX_use_PrivateKey`, `SSL_CTX_check_private_key`
(+ `SSL_CTX_add0_chain_cert` for intermediates — read every X509 in the PEM; first = leaf, rest = chain).
Hardening: `SSL_CTX_set_options` + constants `SSL_OP_NO_RENEGOTIATION` (0x40000000),
`SSL_OP_NO_SSLv3`/`TLSv1`/`TLSv1_1`; min-proto via the existing `SSL_CTX_ctrl(SET_MIN_PROTO_VERSION)`.

## 5. Server context (`tls_server_ctx`) — PER-LISTENER, built+validated in `https.createServer`

The context is **per-listener (one cert+key), NOT process-global** (Codex P2-§174, resolves Q1): unlike the
client's single `g_tls_ctx`, two `https.createServer` calls with different certs need two contexts — a shared
`g_*` would make the second listener present the first's cert. It is created when `https.createServer`
parses its options and owned by that listener's `Net_Server` (one ctx per cert+key; shared across the 3a
workers of the *same* listener since `SSL_new` is thread-safe).

It is **built and validated synchronously inside `https.createServer`** (Codex P2-§89), NOT deferred to
`net_listen_cb`: the existing `net.Server.listen` catches `native.listen` errors and emits `'error'`
async (next tick), but Node throws bad-cert/key from `createServer(...)` itself — a caller's `try/catch`
around `createServer` must see it. So `https.createServer` does, synchronously:

1. `SSL_CTX_new(TLS_server_method())`.
2. Load the leaf cert + chain from `options.cert` PEM (in-memory BIO), the key from `options.key`.
3. `SSL_CTX_check_private_key` — assert key matches cert.
4. Security baseline: min proto **TLS 1.2**; `SSL_OP_NO_RENEGOTIATION` (see §8); rely on OpenSSL 1.1.1+
   strong cipher defaults (no NULL/EXPORT/RC4/DES); no client verification in M1.
5. **Any failure throws synchronously from `createServer`** (bad PEM, key/cert mismatch, missing field) —
   matches Node (`ERR_TLS_*`), never a deferred runtime handshake failure. The validated context handle is
   then carried to `listen`.

Per connection: `SSL_new(listener.ctx)` + `SSL_set_accept_state` + wire rbio/wbio. Cheap; the context is
shared within the listener.

## 6. Connection lifecycle (ordered, mirrors net.odin's existing phases)

New per-conn fields on `Net_Connection`: `ssl: rawptr` (the `^SSL`), `rbio`/`wbio: rawptr`, `tls: bool`,
`tls_handshaking: bool`. (A `Net_TLS` sub-struct pointer is the alternative; inline fields are simpler and
the conn is already large.)

**(a) Accept** — `net_accept_cb`: if listener.tls, `ssl = SSL_new(ctx)`; `rbio = BIO_new(BIO_s_mem())`,
`wbio = BIO_new(BIO_s_mem())`; `SSL_set0_rbio/SSL_set0_wbio`; `SSL_set_accept_state`; `tls_handshaking=true`.
Arm the first recv.

**(b) Handshake** — on each recv completion while `tls_handshaking`:
`BIO_write(rbio, recv_buf, n)`; `r = SSL_accept(ssl)`; then drain wbio → send (any handshake records SSL
produced); branch on `SSL_get_error`. NOTE (Codex P2-§105): `fetch_tls_classify` itself is **not** reusable
— it takes a `Fetch_Request` and acts by calling `fetch_set_watch_mode` on the client socket. Reuse only the
**pure** `SSL_get_error → {Pending(WANT_READ/WANT_WRITE)|Eof(ZERO_RETURN)|Fatal}` mapping (factor it out of
`fetch_tls.odin` into a shared helper); the server's *action* on each outcome is its own (drain wbio + arm a
net SEND, or arm a net RECV), never `fetch_set_watch_mode`:
- `r==1` → handshake done: `tls_handshaking=false`, run any buffered `SSL_read` (a TLS1.3 client may have
  sent app-data with its Finished), then steady-state.
- `WANT_READ` → arm another recv (need more ciphertext).
- `WANT_WRITE` → already drained wbio above; wait for the SEND completion to re-enter.
- else → fatal: close (no close_notify — handshake never completed).

**(c) Steady-state read** — recv completion: `BIO_write(rbio, recv_buf, n)`, then loop
`n = SSL_read(ssl, buf, 16K)`: `n>0` → `on_data(copy as Uint8Array)`; `WANT_READ` → re-arm recv;
`WANT_WRITE` → peer renegotiation attempt (with NO_RENEGOTIATION this surfaces as a fatal alert — close);
`ZERO_RETURN` → peer close_notify → EOF (`on_end`); else fatal.

**(d) Steady-state write** — `net_write_cb`: `SSL_write(ssl, plaintext, len)`, then loop
`BIO_read(wbio, tmp, 16K)` appending each ciphertext chunk to `pending_writes`; rotate/submit via the
**existing** `net_proactor_submit` path (incl. SEND_ZC for large bodies). Backpressure = buffered
**ciphertext** (`active_send` tail + `pending_writes`) ≥ `NET_WRITE_HWM`, identical gate to plaintext.

**(e) Close — a distinct `.TLS_Closing` phase BEFORE the existing hard teardown** (Codex P2-§124). The
current `net_close_conn_proactor` immediately `shutdown(fd, RDWR)` + cancels both recv/send ops
(`net.odin:1003-1005`) — there is no writable socket left for close_notify. So an *orderly* close (a graceful
`socket.end()` / keep-alive close on a handshake-complete TLS conn) must first:
1. enter `.TLS_Closing`; `SSL_shutdown(ssl)` → `BIO_read(wbio)` the close_notify record → queue as a normal
   SEND (the send path is still live — we have NOT hard-closed yet);
2. on that SEND completion, optionally read the peer's close_notify (`SSL_read` → `ZERO_RETURN`) bounded by
   a short timeout (reuse the 3a `net_drain_*` machinery so a half-open peer can't pin the conn);
3. THEN fall into the existing hard path (`net_close_conn_proactor`: shutdown(RDWR), cancel ops),
   `SSL_free` (frees the BIOs) and the fd close on `net_maybe_free`.
An **abrupt/error close** (handshake never completed, a fatal TLS/socket error, or `socket.destroy()`) skips
close_notify and goes straight to the hard path.

## 7. Buffer-lifetime invariants (the safety core — same discipline as the proactor net layer)

INV-T1: `ssl`, `rbio`, `wbio` live for the **whole connection**; freed exactly once in `net_maybe_free`
(after `inflight==0 && closing`), never per-handshake/per-op. A renegotiation must never free a BIO an
in-flight RECV is about to feed.
INV-T2: `recv_buf` (ciphertext landing) and `active_send` (ciphertext in flight) keep their existing
lifetime rules — the kernel-touched buffer outlives its op; `BIO_write(rbio, recv_buf, …)` happens **in the
completion handler before re-arming**, so recv_buf is reused only after its bytes are copied into rbio.
INV-T3: plaintext handed to `on_data` is a **copied** Uint8Array (never a no-copy view into SSL/BIO
internals) — JS may retain it; SSL buffers must not be aliased.
INV-T4: `SSL_free` only after the last in-flight op completes (the `inflight` refcount already guarantees
this); `SSL_free` releases the BIOs (ownership was transferred), so we must not double-free.
INV-T5: SEND_ZC (3b) pins `active_send` (now ciphertext) until its notification — unchanged; the ZC
teardown-leak rule (M1/M2 of the zerocopy slice) applies identically to the ciphertext buffer.

## 8. Security baseline (non-negotiable for a public-facing server)

- **TLS 1.2 floor** (1.3 preferred when available); SSLv2/v3/TLS1.0/1.1 disabled.
- **`SSL_OP_NO_RENEGOTIATION`** by default — peer-initiated renegotiation is a DoS vector (forces perpetual
  BIO draining without app progress) and an attack surface; TLS 1.3 removes it anyway.
- Strong cipher defaults (OpenSSL 1.1.1+ defaults: no NULL/anon/EXPORT/RC4/DES; ECDHE/DHE forward secrecy).
- **Mandatory close_notify** on orderly shutdown (RFC 5246 §7.2.1) — never bare-fd-close a live session.
- Cert/key validated at `listen` (fail fast), not at handshake.
- No client-cert verification in M1 (matches Node default `requestCert:false`).

## 9. JS API surface

`js/internal/https.js` (new): `https.createServer(options, requestListener)`:
1. **Validate options synchronously** — reject the deferred security-sensitive fields (§1) by throwing; then
   build+validate the per-listener `SSL_CTX` from `options.key`/`options.cert` via the native binding, which
   **throws on bad PEM / key-cert mismatch** (§5). This is the synchronous-throw point Node callers expect.
2. Build an `http.Server` (reusing all of `node:http`) and attach the validated TLS context handle, threaded
   through `http.Server.listen` → `net.createServer`/`listen` (the small http.js hook, §3).
`net.listen` gains an optional TLS field carrying the **already-built context handle** (not raw key/cert —
parsing/validation already happened in `createServer`); `net_listen_cb` stamps the listener `tls=true` +
stores the ctx. `https.Server` is `http.Server` with TLS transport — same `'request'` event,
`IncomingMessage`/`ServerResponse`. `tls.createServer` + `TLSSocket` deferred to M2.
Native: `make_https_bindings` (or fold into net) wired into `globals.odin` alongside http/net. **Register the
builtin factory under the unprefixed key `https`** (Codex P2-§160) — the loader strips `node:` and keys the
table by bare names (`net`, `http`), so `require('https')` and `require('node:https')` both resolve;
registering `node:https` literally would break both.

## 10. Proactor + readiness + the buffer-ring/multishot/ZC stack

TLS layers **above** the I/O backend, so it inherits everything: proactor RECV/SEND, the provided-buffer
ring (2a — ciphertext lands in the ring buffer, fed to rbio), multishot RECV (2b — each completion feeds
rbio), SEND_ZC (3b — ciphertext send), multi-core workers (3a — per-worker `tls_server_ctx` is fine; SSL_CTX
is thread-safe for `SSL_new`, or build one per worker). Readiness fallback works identically (decrypt in
`conn_read_cb`, encrypt in `net_flush`). **Idle TLS conn memory ≈ plaintext** (recv_buf already exists; SSL
+ empty BIOs ≈ a few KiB) — the memory moat holds.

## 11. Open questions for review

Q1. **RESOLVED** (Codex P2-§174): SSL_CTX is **per-listener** (one per cert+key, owned by the `Net_Server`),
NOT process-global — two `https.createServer`s with different certs need distinct contexts. Shared across
the 3a workers of the *same* listener (`SSL_new` is thread-safe). See §5.
Q2. PEM in-memory load vs temp-file (`SSL_CTX_use_certificate_file`): in-memory (`BIO_new_mem_buf` +
`PEM_read_bio_*`) avoids FS coupling and matches Node's PEM-content options. (Lean: in-memory.)
Q3. close_notify drain timeout — reuse the 3a `NET_DRAIN_TIMEOUT_MS` machinery, or a shorter TLS-specific
bound? A half-open peer must not pin the conn.
Q4. Inline `Net_Connection` TLS fields vs a heap `^Net_TLS` (only allocated for TLS conns) — memory vs
indirection. (Lean: inline `bool tls` + 3 pointers; cheap, and TLS conns dominate when enabled.)
Q5. Where to gate "renegotiation attempt → close": with `SSL_OP_NO_RENEGOTIATION`, OpenSSL turns a peer
hello into a fatal alert at `SSL_read`; confirm that surfaces cleanly as a fatal (not a hang).

## 12. Test plan (gates)

1. **Smoke** (`tests`/`scripts/run-https-smoke.sh`): `https.createServer` with a self-signed cert →
   `fetch('https://127.0.0.1:…')` (lava's own TLS client) returns the body byte-exact. Both backends
   (proactor + `LAVA_NET_FORCE_READINESS`). Its own CI gate (binds a port), like the other smokes.
2. Request/response + keep-alive + chunked over TLS (http parity, encrypted).
3. Orderly close sends close_notify; peer EOF mid-handshake and post-handshake both close cleanly.
4. `socket.destroy()` reentrancy: mid-handshake, mid-read, mid-write (one async op in flight) — no UAF/hang.
5. Cert/key load errors fail `listen` synchronously (bad PEM, key/cert mismatch).
6. Renegotiation attempt is rejected (no hang).
7. **Crash guard**: 500+ concurrent TLS handshakes under `JSC_scribbleFreeCells` + `JSC_collectContinuously`
   — no crash (the M2-class GC-UAF guard).
8. Cross-platform type-check (darwin/windows: server bindings are Linux-first like the proactor; stub/guard
   the rest).
9. Adversarial verification (multi-lens) of the handshake state machine + buffer-lifetime (INV-T1..T5)
   before merge, like every proactor slice.

## 13. Commit staging (design-first → one impl PR, or two)

C1 (docs): this design — review before impl.
C2 (eventloop/tls): OpenSSL server bindings + `tls_server_ctx` + `tls_new_server_ssl` (SSL + BIO wiring) +
the handshake/read/write/close helpers (`tls_server.odin`), with unit tests on the state machine where
observable.
C3 (net): wire TLS into `net_accept_cb`/recv/write/close paths + the `net.listen` TLS option; `https.js` +
`make_https_bindings`; the https smoke + CI gate; cross-checks.
(Or C2+C3 as one impl PR, like the smaller slices.)
