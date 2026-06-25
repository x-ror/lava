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

**The `recv_buf → BIO_write(rbio)` copy is REQUIRED, not an inefficiency to "optimize" away (m7):** a TLS
record can split across two RECV completions, so rbio must *retain* undrained ciphertext between completions
— which `BIO_s_mem` does and a zero-copy read-only `BIO_new_mem_buf` over `recv_buf` does NOT. Replacing the
copy with a mem-buf BIO over the landing buffer would silently corrupt reassembly of split records.

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

## 4. New OpenSSL bindings — in a NEW `tls_server.odin` (`#+build linux`), NOT `tls.odin`

**Location (rev.3, was "add to tls.odin"; Codex-R2 M1):** the server bindings + helpers live in a new
`tls_server.odin` carrying **`#+build linux`** — co-located with the Linux-only `net.odin` server it serves.
`tls.odin` is `#+build linux, windows` (the fetch client runs on Windows); putting server symbols there would
compile dead code on Windows where there is no `net.odin` to call them. (Resolves the old §4-vs-§13
contradiction.) libssl/libcrypto are already linked.

Server method + handshake + shutdown: `TLS_server_method`, `SSL_accept`, `SSL_shutdown`,
`SSL_set_accept_state`.
Memory BIOs: `BIO_new` + `BIO_s_mem`, `BIO_write`, `BIO_read`, `BIO_new_mem_buf`, `BIO_free`,
`SSL_set0_rbio`, `SSL_set0_wbio` (rbio/wbio ownership transfers to the SSL; freed by `SSL_free`).
PEM load from memory (Node passes PEM *content*, not paths): `PEM_read_bio_X509`,
`PEM_read_bio_PrivateKey` (called with an **explicit no-op password callback** — never NULL, which would
prompt on the terminal and hang on an encrypted key; M3), `SSL_CTX_use_certificate`, `SSL_CTX_use_PrivateKey`,
`SSL_CTX_check_private_key`, `SSL_CTX_add0_chain_cert` (transfers ownership; for intermediates — read every
X509 in the PEM, first = leaf, rest = chain). Free the transients after install — `X509_free` (leaf),
**`EVP_PKEY_free`**, **`BIO_free`** (M3); `use_certificate`/`use_PrivateKey` up-ref their args.
Context lifetime: **`SSL_CTX_up_ref`** + `SSL_CTX_free` (per-listener ctx, refcounted across 3a workers; M2).
Resumption OFF (M1 scope; C2): **`SSL_CTX_set_num_tickets(ctx,0)`** (TLS 1.3) +
`SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_OFF)` + `SSL_OP_NO_TICKET` (TLS 1.2).
Idle-memory (M5): **`SSL_CTX_set_mode(ctx, SSL_MODE_RELEASE_BUFFERS)`**.
Hardening: `SSL_CTX_set_options` + `SSL_OP_NO_RENEGOTIATION` (0x40000000, **OpenSSL ≥ 1.1.1h** — see §8),
`SSL_OP_NO_SSLv3`/`TLSv1`/`TLSv1_1`; min-proto via the existing `SSL_CTX_ctrl(SET_MIN_PROTO_VERSION)`.
Opaque types to add: `EVP_PKEY`.

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
2. Load the leaf cert + chain from `options.cert` PEM (in-memory BIO), the key from `options.key` — with an
   **explicit no-op password callback** so an encrypted key fails closed (throws) rather than blocking on a
   terminal prompt (M3). Free the transient leaf `X509`, `EVP_PKEY`, and `BIO` after install (M3).
3. `SSL_CTX_check_private_key` — assert key matches cert.
4. Security baseline: min proto **TLS 1.2**; `SSL_OP_NO_RENEGOTIATION` (see §8); OpenSSL 1.1.1+ strong
   cipher defaults (no NULL/EXPORT/RC4/DES); no client verification in M1.
5. **Resumption OFF (C2):** `SSL_CTX_set_num_tickets(ctx, 0)` (else OpenSSL emits 2 NewSessionTickets by
   default — shipping the resumption M1 defers, stranding ticket records in wbio, and growing an unmanaged
   session cache that breaks the memory moat) + `SSL_SESS_CACHE_OFF` + `SSL_OP_NO_TICKET` (TLS 1.2).
6. **Idle memory (M5):** `SSL_CTX_set_mode(ctx, SSL_MODE_RELEASE_BUFFERS)` so OpenSSL frees the ~16 KiB
   per-SSL read/write buffers between records on idle keep-alive conns (without it, idle ≈ 33 KiB/conn, ~10×
   the moat budget).
7. **Any failure throws synchronously from `createServer`** (bad PEM, encrypted key w/o passphrase, key/cert
   mismatch, missing field) — matches Node (`ERR_TLS_*`), never a deferred runtime handshake failure. The
   validated context handle is carried to `listen`; ownership + free in §7 INV-T6.

Per connection: `SSL_new(listener.ctx)` + `SSL_set_accept_state` + wire rbio/wbio. Cheap; the context is
shared within the listener.

## 6. Connection lifecycle (ordered, mirrors net.odin's existing phases)

New per-conn fields on `Net_Connection`: `ssl: rawptr` (`^SSL`), `rbio`/`wbio: rawptr`, `tls`,
`tls_handshaking`, `tls_closing: bool`, and a handshake-deadline timer handle (M4). (Inline fields vs a heap
`^Net_TLS` — lean inline; the conn is already large.)

**INVARIANT — applies after EVERY SSL op below (C1 + m1).** After any `SSL_accept`/`SSL_read`/`SSL_write`/
`SSL_shutdown`: (1) **stash the outcome via `SSL_get_error` IMMEDIATELY**, before any other OpenSSL call
(error-state is thread-local; m1); (2) **ALWAYS `BIO_read(wbio,…)` → SEND** any produced ciphertext; (3) then
act on the stashed outcome. OpenSSL emits outbound records *during `SSL_read`* too — TLS 1.3 NewSessionTicket
(lazy, first post-handshake read), KeyUpdate responses, alerts — so draining wbio only on the write/handshake
paths strands ciphertext and **desyncs the record layer (C1)**. "drain wbio → send" is a post-condition of
*every* SSL call, not a per-path step. Reuse only the pure `SSL_get_error → {Pending(WANT_READ/WANT_WRITE)|
Eof(ZERO_RETURN)|Fatal}` mapping (factored out of `fetch_tls.odin` — NOT `fetch_tls_classify`, which is
`Fetch_Request`-bound + arms the client watcher; Codex-R1 §105). The server's *action* is its own.

**(a) Accept** — `net_accept_cb`, **before invoking `on_connection`** (so JS sees a TLS socket from the first
tick; m2): if listener.tls → `ssl = SSL_new(listener.ctx)`; rbio/wbio = `BIO_new(BIO_s_mem())`;
`SSL_set0_rbio/wbio`; `SSL_set_accept_state`; `tls=true`; `socket.encrypted=true` (§3/§9);
`tls_handshaking=true`; **arm the handshake-deadline timer** (M4 — abrupt-destroys the conn on expiry).
Recv-arming is reconciled with `net_start_cb` so there is **exactly one armed recv** and **no decrypted
`on_data` ever fires before the JS `'data'` handler is attached** (m2): the handshake consumes recv
completions internally; the first plaintext `'data'` fires only after BOTH handshake-done AND handlers
registered.

**(b) Handshake** — each recv completion while `tls_handshaking`: `BIO_write(rbio, recv_buf, n)`;
`SSL_accept`; *[invariant: stash error; drain wbio→SEND]*; then:
- `r==1` → done: **cancel the handshake-deadline timer** (M4); `tls_handshaking=false`; run a steady-state
  `SSL_read` pass (a TLS 1.3 client may bundle app-data with Finished); → steady-state.
- `Pending/WANT_READ` → arm another recv.
- `Pending/WANT_WRITE` → wbio already sent by the invariant; await the SEND completion to re-enter.
- `Fatal` → abrupt close (no close_notify — handshake never completed).

**(c) Steady-state read** — recv completion: `BIO_write(rbio, recv_buf, n)`; loop `SSL_read(ssl, buf, 16K)`:
`n>0` → `on_data(copy as Uint8Array)`. *[invariant: drain wbio→SEND]* — this is the TLS 1.3
KeyUpdate/ticket-flush case (C1). Outcome: `WANT_READ` → re-arm recv; `WANT_WRITE` → **NOT a close** — it is
OpenSSL needing to flush (the KeyUpdate response is already sent by the invariant); continue / await the SEND
(C1 corrects the earlier "close as renegotiation" — a *real* peer renegotiation with `SSL_OP_NO_RENEGOTIATION`
surfaces as a `Fatal` alert, handled by Fatal); `ZERO_RETURN` → peer close_notify → EOF (`on_end`); `Fatal` →
abrupt close.

**(d) Steady-state write** — `net_write_cb`: `SSL_write(ssl, plaintext, len)`; *[invariant: drain wbio→SEND]*
loop `BIO_read(wbio, tmp, 16K)` → `pending_writes`; rotate/submit via the **existing** `net_proactor_submit`
(incl. SEND_ZC). Backpressure = buffered **ciphertext** (`active_send` tail + `pending_writes`) ≥
`NET_WRITE_HWM`, identical gate.

**(e) Close — distinct `.TLS_Closing` phase, on BOTH backends** (Codex-R1 §124; m4, m6). The hard paths
(`net_close_conn_proactor`: `shutdown(RDWR)` + cancel ops, `net.odin:1003-1005`; and the readiness
`net_close_conn`, ~1236) leave no writable socket for close_notify. So an *orderly* close (graceful
`socket.end()`/keep-alive close on a handshake-complete conn) first: enter `.TLS_Closing`; `SSL_shutdown`;
*[invariant: drain wbio→SEND the close_notify record]*; on that SEND completing, **proceed straight to the
hard path — do NOT wait for the peer's close_notify** (RFC 5246 §7.2.1: sending ours is required, reading
theirs is courtesy; waiting pins the conn). **No new per-conn timer**, and do NOT reuse
`net_drain_*`/`NET_DRAIN_TIMEOUT_MS` (a 10 s loop-shutdown `Shutdown_Hook`, not a per-conn facility — m4).
Then `SSL_free` (frees the BIOs), fd close on `net_maybe_free`. **Abrupt/error close** (handshake incomplete,
fatal error, `socket.destroy()`) skips close_notify → hard path. This phase exists on the **readiness path
too** (m6), not only proactor.

## 7. Buffer-lifetime invariants (the safety core — same discipline as the proactor net layer)

INV-T1: `ssl`, `rbio`, `wbio` live for the **whole connection**; freed exactly once in `net_maybe_free`
(after `inflight==0 && closing`), never per-handshake/per-op. A renegotiation must never free a BIO an
in-flight RECV is about to feed.
INV-T2: the ciphertext landing buffer keeps its existing lifetime rules — the kernel-touched buffer outlives
its op; `BIO_write(rbio, …)` happens **in the completion handler before the buffer is reused/recycled**, so
the bytes are copied into rbio first. This covers ALL three recv modes (m5): readiness/single-shot `recv_buf`;
**`.ProactorRing` (2a)** — there is NO `recv_buf`; ciphertext lands in a ring buffer (`bid`) which must be
`BIO_write`-copied into rbio **before it is recycled to the ring** (`net_recv_ring_complete`); **multishot
(2b)** — each completion's buffer fed to rbio before the next.
INV-T3: plaintext handed to `on_data` is a **copied** Uint8Array (never a no-copy view into SSL/BIO
internals) — JS may retain it; SSL buffers must not be aliased.
INV-T4: `SSL_free` only after the last in-flight op completes (the `inflight` refcount already guarantees
this); `SSL_free` releases the BIOs (ownership was transferred), so we must not double-free.
INV-T5: SEND_ZC (3b) pins `active_send` (now ciphertext) until its notification — unchanged; the ZC
teardown-leak rule (M1/M2 of the zerocopy slice) applies identically to the ciphertext buffer.
INV-T6 (M2 — SSL_CTX lifetime): the **per-listener** `SSL_CTX` (cert chain + key) is owned by the listener's
`Net_Server`, NOT process-global like the client's never-freed `g_tls_ctx`. It is **`SSL_CTX_free`d exactly
once on listener teardown** (`server.close()` / the listener-close path) — else every `createServer`/`close`
cycle leaks a ctx+chain+key. Across 3a workers sharing one listener it is **refcounted** (`SSL_CTX_up_ref`
per worker that adopts it, freed when the last releases) so no worker double-frees. (This pins down the §10
ambiguity: one shared ctx, refcounted — not one-per-worker.)

## 8. Security baseline (non-negotiable for a public-facing server)

- **TLS 1.2 floor** (1.3 preferred when available); SSLv2/v3/TLS1.0/1.1 disabled.
- **`SSL_OP_NO_RENEGOTIATION`** by default — peer-initiated renegotiation is a DoS vector and an attack
  surface; TLS 1.3 removes it anyway. NOTE (m8): this flag exists only in **OpenSSL ≥ 1.1.1h** — on older
  1.1.1 it is a silent no-op, leaving TLS 1.2 peer-renegotiation unblocked. Either require ≥ 1.1.1h (CI's
  OpenSSL is newer) OR add an `SSL_CTX_set_info_callback` that aborts on a second handshake as a 1.2
  fallback. (Distinct from TLS 1.3 KeyUpdate, which is normal and handled in §6c, NOT renegotiation.)
- **Resumption disabled** (C2): `SSL_CTX_set_num_tickets(0)` + `SSL_SESS_CACHE_OFF` + `SSL_OP_NO_TICKET` —
  OpenSSL sends 2 NewSessionTickets by default; M1 defers resumption, and leaving it on ships broken
  resumption + an unmanaged growing session cache.
- **Handshake timeout** (M4): a per-conn deadline armed on `.TLS_Handshake` entry, cancelled on completion,
  abrupt-destroys the conn on expiry — http.js's timeouts only start *post*-handshake, so without this a
  stalled/partial ClientHello is a pre-application slowloris (fd + SSL + 2 BIOs held unbounded).
- **Encrypted key fails closed** (M3): an explicit no-op PEM password callback — never NULL (which prompts
  on the terminal and *hangs* the server on an encrypted key); a missing passphrase throws from
  `createServer`.
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
Native: `make_https_bindings` lives in `tls_server.odin` (`#+build linux`) and is registered in `globals.odin`
under the unprefixed key **`https`** (Codex-R1 §160 — the loader strips `node:` and keys by bare names, so
`require('https')` and `require('node:https')` both resolve; the prefixed key would break both), **guarded by
the same `when ODIN_OS == .Linux` as `make_net_bindings`/`make_http_bindings`** (M1 — net.odin is
`#+build linux`); on non-Linux `require('https')` throws a clear "not supported" rather than a
missing-factory error.
**`socket.encrypted` propagation mechanism (m3):** native signals "this conn is TLS" to the JS `Socket`
constructor in `net.js`'s connection path via an explicit flag on the start/connection callback (a boolean
arg, mirroring how the conn id is passed) — the JS `Socket` sets `this.encrypted = true` when set; plaintext
conns leave it `undefined` (as today). Not inferred in JS.

## 10. Proactor + readiness + the buffer-ring/multishot/ZC stack

TLS layers **above** the I/O backend, so it inherits everything: proactor RECV/SEND, the provided-buffer
ring (2a — ciphertext lands in the ring buffer, fed to rbio), multishot RECV (2b), SEND_ZC (3b — ciphertext
send), multi-core workers (3a — **one per-listener `SSL_CTX` shared across the listener's workers, refcounted
via `SSL_CTX_up_ref`**, NOT one-per-worker; INV-T6). Readiness fallback works identically — decrypt in
`conn_read_cb`, encrypt in `net_flush`, **and the `.TLS_Closing` close_notify phase applies there too** (§6e,
m6).

**Idle memory (M5 — correcting the earlier "≈ a few KiB"):** each `SSL` keeps ~16 KiB read + ~16 KiB write
buffers for the connection's life by default → an idle keep-alive TLS conn would be **~33 KiB**, ~10× the
moat budget and exactly the wrong direction for a server built to hold many idle conns. **`SSL_CTX_set_mode(
SSL_MODE_RELEASE_BUFFERS)`** (§5) frees those between records on idle conns, restoring idle ≈ plaintext. This
is a load-bearing claim → it gets an idle-keep-alive memory test (§12).

## 11. Open questions for review

Q1. **RESOLVED** (Codex P2-§174): SSL_CTX is **per-listener** (one per cert+key, owned by the `Net_Server`),
NOT process-global — two `https.createServer`s with different certs need distinct contexts. Shared across
the 3a workers of the *same* listener (`SSL_new` is thread-safe). See §5.
Q2. PEM in-memory load vs temp-file (`SSL_CTX_use_certificate_file`): in-memory (`BIO_new_mem_buf` +
`PEM_read_bio_*`) avoids FS coupling and matches Node's PEM-content options. (Lean: in-memory.)
Q3. **RESOLVED** (Codex-R2 m4): on orderly close, send our close_notify and proceed straight to the hard
path — do NOT wait for the peer's close_notify (courtesy, not required; RFC 5246 §7.2.1) and do NOT reuse the
10 s loop-shutdown `net_drain_*`. No per-conn close timer. See §6e.
Q4. Inline `Net_Connection` TLS fields vs a heap `^Net_TLS` (only allocated for TLS conns) — memory vs
indirection. (Lean: inline `bool tls` + pointers; cheap, and TLS conns dominate when enabled.)
Q5. **RESOLVED** (Codex-R2 C1): `WANT_WRITE` during `SSL_read` is the TLS 1.3 KeyUpdate/flush case → drain
wbio + continue (NOT a close); a *real* peer renegotiation under `SSL_OP_NO_RENEGOTIATION` surfaces as a
`Fatal` alert (handled by the Fatal arm). The §4-vs-§13 build-tag contradiction is also resolved: server
code is in a new `tls_server.odin` (`#+build linux`), §4 corrected.

## 12. Test plan (gates)

1. **Smoke** (`tests`/`scripts/run-https-smoke.sh`): `https.createServer` with a self-signed cert →
   `fetch('https://127.0.0.1:…')` (lava's own TLS client) returns the body byte-exact. Both backends
   (proactor + `LAVA_NET_FORCE_READINESS`). Its own CI gate (binds a port), like the other smokes.
2. Request/response + keep-alive + chunked over TLS (http parity, encrypted).
3. Orderly close sends close_notify; peer EOF mid-handshake and post-handshake both close cleanly.
4. `socket.destroy()` reentrancy: mid-handshake, mid-read, mid-write (one async op in flight) — no UAF/hang.
5. Cert/key errors fail `createServer` **synchronously** (bad PEM, key/cert mismatch). **Encrypted key
   without passphrase THROWS, does not hang** (M3) — the test must wrap a timeout to catch a regression.
6. Renegotiation attempt is rejected (no hang).
7. **TLS 1.3 ticket/KeyUpdate path** (C1/C2): a real client (`openssl s_client -keyupdate`, or a TLS 1.3
   fetch) post-handshake exchange — assert no record-layer desync and **no ciphertext stranded in wbio**;
   assert NO NewSessionTicket is sent (resumption disabled).
8. **Stalled/partial handshake timeout** (M4): open a conn, send a truncated/dribbled ClientHello (or
   nothing) — assert it is reaped by the handshake deadline.
9. **Idle keep-alive memory** (M5): hold N idle TLS conns — assert per-conn RSS near the moat budget (catches
   a missing `SSL_MODE_RELEASE_BUFFERS`).
10. **`createServer`/`close` leak loop** (M2/M3): many cycles under a leak check — assert flat memory
    (catches `SSL_CTX`/`X509`/`EVP_PKEY`/`BIO` leaks).
11. **Multi-worker shared ctx** (M2/§10, 3a): concurrent handshakes across workers on one listener — no
    crash / double-free (refcounted ctx).
12. **Backpressure with ciphertext** (§6d): a large response pushing buffered ciphertext past
    `NET_WRITE_HWM` — assert `write()` reports backpressure and reads pause.
13. **Crash guard**: 500+ concurrent TLS handshakes under `JSC_scribbleFreeCells` + `JSC_collectContinuously`
    — no crash (the M2-class GC-UAF guard).
14. Cross-platform type-check; `require('https')` on darwin/windows throws a clear "not supported" (server is
    Linux-first like the proactor; M1).
15. Adversarial verification (multi-lens) of the handshake state machine + buffer-lifetime (INV-T1..**T6**)
    before merge, like every proactor slice — with the C1 wbio-drain invariant as a dedicated lens.

## 13. Commit staging (design-first → one impl PR, or two)

C1 (docs): this design — review before impl.
C2 (tls): a new **`tls_server.odin` (`#+build linux`)** — OpenSSL server bindings + per-listener
`tls_server_ctx` (with §5's hardening: no tickets, RELEASE_BUFFERS, no-op pw cb, free transients) +
`tls_new_server_ssl` (SSL + BIO wiring) + the handshake/read/write/close helpers honoring the §6 drain-wbio
invariant; unit tests on the state machine where observable. The shared pure `SSL_get_error→outcome` mapping
is factored out of `fetch_tls.odin`.
C3 (net): wire TLS into `net_accept_cb`/recv/write/close paths (incl. the `.TLS_Closing` phase on **both**
backends + the handshake-deadline timer) + the `net.listen` TLS option + `socket.encrypted`; `https.js` +
`make_https_bindings` registered as `https` **under the same `when ODIN_OS == .Linux` guard as net/http**;
the https smoke + CI gate; cross-checks (require('https') throws on non-Linux).
(Or C2+C3 as one impl PR, like the smaller slices.)
