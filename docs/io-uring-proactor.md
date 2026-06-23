# io_uring proactor (design)

Status: design / in progress. Tracks the move from the current **readiness** use of io_uring
to a **completion** (proactor) model for sockets, the "win lane" from the runtime strategy:
fewer syscalls per request and — with provided-buffer-rings — the lowest memory-per-idle-
connection of any of Node/Bun/Lava.

## Where we are today (readiness on io_uring)

`pkg/runtime/eventloop/loop_linux.odin` already has an io_uring backend, but it is used as a
drop-in **epoll**: `platform_watch_fd` submits a one-shot `IORING_OP_POLL_ADD` for `.IN`/`.OUT`
and re-arms it on each completion (`drain_uring_completions`). The watcher *callback* then does
the actual transfer with raw `linux.recv`/`linux.send` (see `net.odin` `conn_read_cb` /
`net_flush`). The two sides differ today: the **read** side is a poll→recv pair (POLL_ADD
completion, then the callback's `recv`), but the **write** side already sends eagerly —
`net_flush` calls `linux.send` immediately and only arms `.Write` after `EAGAIN`. So the
clear per-request syscall win is on the read side (poll+recv → one RECV); the proactor SEND
mainly unifies the model and unlocks later batching/zero-copy, it is not a syscall reduction
on the common (un-backpressured) write path.

Stale-completion safety is handled by a **generation-token watcher table**
(`Uring_Watch_Slot` + `uring_encode_token`): a completion carries `(slot index, generation)`,
not a raw pointer, so a completion that races `unwatch_fd` is dropped without dereferencing a
possibly-freed watcher. **The proactor reuses this exact scheme for op completions.**

Profiling the hello-world server (after the timer + write-coalesce fixes) shows the remaining
cost is dominated by the per-request `recv`/`send` syscalls — the proactor's target.

## Goal (completion mode)

Submit the transfer itself to the kernel and act on its completion:

- **RECV**: submit `IORING_OP_RECV`; the completion delivers the bytes (count in `cqe.res`).
  Eliminates the poll→recv round-trip (one enter instead of two on the read side).
- **SEND**: submit `IORING_OP_SEND`; the completion reports bytes sent. This is model
  unification (and removes the backpressure re-arm dance), not a syscall reduction — the
  write side already sends eagerly today. It must handle **partial completions** (see safety
  rule 2).
- **Multishot RECV + provided-buffer-ring** (the memory win): `IORING_OP_RECV` submitted once
  with the `RECVSEND.MULTISHOT` flag + `IOSQE.BUFFER_SELECT` yields many completions, each
  naming a kernel-picked buffer from a *shared* ring. (This is the socket-recv multishot —
  distinct from `IORING_OP_READ_MULTISHOT`/`uring.read_multishot`, which is a file/pipe read
  helper and is NOT what we use.) An idle keep-alive connection then holds **no** per-
  connection read buffer — the buffer is consumed only when data actually arrives. This is
  the moat: memory-per-idle-connection drops below Node/Bun.

## ABI status (Odin `core:sys/linux`)

- `IORING_OP.{RECV,SEND}`, the `RECVSEND.MULTISHOT` flag, `IOSQE.BUFFER_SELECT`,
  `REGISTER_PBUF_RING`/`UNREGISTER_PBUF_RING`, `IORING_OFF_PBUF_RING`, and the SQE
  `buf_group`/`buf_index` fields are all present — the kernel ABI is fully exposed. Socket
  multishot receive is `IORING_OP_RECV` + `RECVSEND.MULTISHOT` + `BUFFER_SELECT` (we do NOT
  use the `IORING_OP_READ_MULTISHOT` opcode / `uring.read_multishot`, a separate file-read
  helper).
- The `uring` package has `recv`/`send`/`recvmsg`/`sendmsg` helpers, but `provide_buffers`
  (and `read_multishot`) are **empty stubs** — so the buf-ring register/refill/recycle
  plumbing and the `MULTISHOT|BUFFER_SELECT` RECV submission are ours to write directly
  against the SQE (Slice 2). No missing kernel headers; just unwritten helpers.

## Safety model (the part that must be right)

This is completion-mode kernel I/O against JS-owned and native buffers; the lifetime rules
are the whole ballgame (the M2 crash was a buffer-lifetime bug — see
`http-server-concurrency-crash`).

1. **Op identity = generation token in a SEPARATE domain, never a pointer.** Each op carries
   a token from an op-slot table (same design as `Uring_Watch_Slot`). Op tokens must be
   distinguishable from the existing *poll-watcher* tokens — both are otherwise `>= 1<<32`,
   and `drain_uring_completions` currently treats every non-sentinel `user_data` as a
   watcher-table index, so an undistinguished op CQE would be dropped as stale or, worse,
   dispatch an unrelated live watcher. Reserve **bit 63 as a domain discriminator**: `0` =
   poll-watcher token (existing scheme), `1` = op token; within each domain the layout is
   `(generation:31) << 32 | (index:32)` (generation capped to 31 bits, still skipping 0 on
   wrap). Sentinels (wakeup=1, cancel=2) keep bit 63 clear and are matched by exact value
   first; `drain_uring_completions` then dispatches by bit 63 (set → op-slot, clear →
   watcher-slot). A completion mapping to a released slot (generation mismatch) is dropped
   without touching freed memory.
2. **A submitted buffer is pinned until that op's terminal CQE.** For RECV the destination
   buffer (per-conn in Slice 1, ring-owned in Slice 2) must outlive the op. For SEND the
   *source* bytes must outlive submission — SEND owns a per-op buffer in the connection's
   write state. SEND can complete **partially** (`cqe.res < len`, exactly like `send(2)`): on
   a short completion the unsent tail `buf[cqe.res:]` is re-submitted and the storage is
   freed only once the whole buffer has been acknowledged — never on the first completion. No
   JS-owned `Uint8Array` backing is handed to the kernel and released before completion.
3. **Buffer reclaim is tied to the op's terminal CQE, not to teardown.** On `net_close_conn`
   with an in-flight RECV/SEND, `ASYNC_CANCEL` + a generation bump only stops *stale dispatch*
   — the original op still produces a terminal CQE (its own `-ECANCELED`, or a real
   completion that beat the cancel), and the kernel may still write into the RECV buffer / read
   the SEND buffer until then. So the op buffer is freed when its CQE drains, even if the
   connection slot is already stale (the op-slot, not the connection, owns the buffer's life).
   `net_close_conn` defers the `Net_Connection` free as today; the op buffers are reclaimed by
   their completions. On loop destroy, buffers are reclaimed after the ring is drained/closed.
4. **Provided buffers are kernel-owned while armed.** A ring buffer is ours to read only
   between its completion and our recycle of it; we never free ring memory while the ring is
   registered. `-ENOBUFS` (ring momentarily empty) re-arms after refill rather than dropping
   the connection.
5. **Feature-gate + fallback.** Multishot recv and PBUF_RING need a recent kernel (≈5.19+/6.0).
   Probe at init; fall back to Slice-1 single-shot, then to the readiness path, then to epoll.

### What actually gates a slice

The hard gates (a regression fails the change): the `node:http`/`net` smokes, `test-all`,
the full node-compat suite, and the **crash guard** — the server under
`JSC_scribbleFreeCells=1 JSC_collectContinuously=1` (the standing M2-regression check). The
HTTP **benchmark is report-only**: `make bench-http` / `bench/http/run-http-bench.mjs` prints
req/s + mem-per-conn but has no thresholds and never fails. So each slice's perf claim is a
**manual** before/after comparison recorded on its PR; if we want CI to enforce throughput or
memory non-regression we must add a thresholded `--gate` mode to the bench (a follow-up,
mirroring the existing `bench --gate`), not rely on the report.

## Slices (each its own PR; crash-gated, perf measured)

- **Slice 1 — single-shot RECV/SEND completion path for net connections.** Adds an op-slot
  table + `submit_recv`/`submit_send` eventloop primitives and a `Net_Connection` proactor
  mode (per-conn recv buffer). Throughput win (poll+recv → recv); no memory change yet.
  Behind a capability flag, coexisting with the readiness path; fetch and other fds unchanged.
- **Slice 2 — provided-buffer-ring + multishot RECV.** The memory moat: shared buf_ring,
  `IORING_OP_RECV` + `RECVSEND.MULTISHOT` + `BUFFER_SELECT`, completion→buffer-id decode,
  recycle, `-ENOBUFS` re-arm. Target: lowest mem/idle-conn of the three runtimes, measured
  (report-only) by `make bench-http`.
- **Slice 3 — send-side scaling.** SEND batching / `MSG_ZEROCOPY` for large bodies;
  `SO_REUSEPORT` + per-core acceptors for multi-core throughput.

## Non-goals (for now)

Windows/macOS proactor (Linux-first; those stay on their current backends). Replacing the
readiness path for fetch/file fds — the proactor is opt-in per connection-class.

## Slice 1b — wiring net connections onto the proactor (detailed design, rev. 2)

Rev. 2 incorporated the first review (3 Critical + 7 Major + 2 Minor). **Rev. 3** fixes the
second review's findings — second-order bugs the rev.2 fixes themselves introduced (concurrent
recvs, lost allocator, missing per-conn mode, drain reentrancy, shutdown leak).

Connections become **full proactor** (recv op + send op, no readiness watcher) when
`proactor_available` AND the first submit succeeds, else stay on the readiness path. Per-conn.

### Connection state (proactor mode)
- `io_mode: enum { Readiness, Proactor }` (rev.3) — set to `.Proactor` ONLY after a successful
  first `submit_recv`; until then (and on any fallback) the connection is `.Readiness`. close/
  write/shutdown branch on `io_mode`, never on the global `proactor_available` or on op-ID
  liveness (after EOF both op IDs are `OP_ID_INVALID` yet the conn is still a proactor conn).
- `recv_buf: []byte` — a per-conn **kernel landing zone** (NET_PROACTOR_RECV = **16 KiB**, not
  64 KiB). It is REUSED across recvs; its bytes are **copied** into a JSC-owned allocation per
  chunk and never handed to JSC no-copy (Critical 2 — `make_uint8_array` transfers ownership to
  JSC, which may retain/free it; reusing the buffer would overwrite an emitted Buffer and
  double-free). The per-conn allocation is a real idle-memory cost (Major 9) — see "Memory".
- Writes use **two `[dynamic]byte`** buffers (Critical 1 — an Odin `[dynamic]` append can
  realloc/free its backing while io_uring still holds the old pointer): `active_send` +
  `active_send_off: int` is the IMMUTABLE buffer currently submitted to a send op (never
  resized/moved/freed before its CQE; the op submits `active_send[active_send_off:]`);
  `pending_writes` is the mutable queue appends land in. Both stay `[dynamic]byte` — a plain
  `[]byte` would lose the allocator + capacity, so `delete` could free with the wrong allocator/
  len (rev.3). When idle they are **rotated** (swap the two dynamic arrays, then `clear` the new
  `pending_writes`), preserving each backing's allocator/capacity and avoiding per-write churn.
- `recv_op`, `send_op: Op_ID`; `inflight: int` (op refcount); `read_paused`, `read_done: bool`
  (rev.3 — set at EOF, gates re-arm); `want_drain: bool`; `closing`, `silent_close`, `had_error`,
  `end_after_drain`.
- **`maybe_arm_recv(conn)` is the single chokepoint that submits a recv** (rev.3, Critical):
  it submits one ONLY when `recv_op == OP_ID_INVALID && !read_paused && !read_done && !closing`,
  so a recv can never be armed while one is already in flight (two kernel ops writing the same
  `recv_buf` = corruption/UAF), nor after EOF, nor during teardown. Every arm site calls it.

### Read lifecycle
- `net_start_cb`: alloc `recv_buf`; `id := submit_recv(...)`; if `id != OP_ID_INVALID`, set
  `io_mode = .Proactor`, `recv_op = id`, `inflight += 1`; **else free `recv_buf` and fall back to
  the readiness path** (init the watcher) — `io_mode` stays `.Readiness` (Major 4 + rev.3: never
  count a failed submit; the mode is set only on success).
- `on_recv_complete(conn, res)`: clear `recv_op`. If not `closing`:
  - `res > 0` → **copy** `recv_buf[:res]` into a fresh JSC-owned `Uint8Array` (the per-chunk
    copy, Critical 2) and call `on_data`; then `maybe_arm_recv(conn)` (its guards handle a
    handler that closed/paused — no separate check, and crucially it won't double-arm).
  - `res == 0` → set **`read_done = true`** (rev.3), `on_end` (true half-close; `maybe_arm_recv`
    will now never re-arm).
  - `res < 0`: `-ECANCELED` is teardown (no error — handled by `op_finished`); **`-EINTR`/
    `-EAGAIN` are transient → `maybe_arm_recv`** to re-submit a **fresh** recv (NOT a synchronous
    user-space spin — a new io_uring submit, after which the kernel arms its own internal poll
    past the initial `EAGAIN`); any other negative → `on_error` + `net_close_conn`.
- **End every completion with `op_finished(conn)`** = `inflight -= 1`; `maybe_free(conn)` — the
  LAST action, after all JS calls and all `conn.*` access (Critical 3). A synchronous
  `socket.destroy()` inside `on_data` sets `closing` and runs `maybe_free` while this op is still
  counted (`inflight >= 1` → no free); the conn is freed only when this completion's trailing
  decrement reaches 0. The inflight count IS the callback-held reference.

### Write lifecycle
- `net_write_cb` (proactor): append to `pending_writes`. If `send_op == OP_ID_INVALID`, **rotate**
  (`active_send` ⇄ `pending_writes`, `clear(&pending_writes)`, rev.3 — preserves allocator/cap),
  `active_send_off = 0`, submit `active_send[:]`; count only a valid id (on failure →
  error-and-close). Returns backpressure per the high-water rule — NOT "a send is in flight" (Major 8).
- `on_send_complete(conn, res)`: clear `send_op`. If not `closing`:
  - `res > 0` → `active_send_off += res`. If `< len(active_send)` re-submit `active_send[off:]`
    (partial send; same backing, never moved — Critical 1). Else `active_send` is fully sent:
    if `pending_writes` is non-empty, rotate+submit; else drained → `clear(&active_send)`, then run
    the **drain transition** (below) and, re-checking state afterwards, `maybe_arm_recv(conn)` and
    (if `end_after_drain`) close.
  - `res == 0` on a non-empty submission → no-progress → treat as error + close (Minor 11).
  - `res < 0`: `-ECANCELED` is teardown; **`-EINTR`/`-EAGAIN` → re-submit `active_send[off:]`**
    (a fresh op, not a spin); any other negative → `on_error` + close.
- Trailing `op_finished(conn)` as for reads.

### Backpressure & drain (Major 8; reentrancy-safe per rev.3)
Every io_uring send is asynchronous, so "a send is in flight" is NOT backpressure. Backpressure
is a **queued-byte high-water mark** (`writableHighWaterMark`, default 16 KiB): `net_write_cb`
returns `false` only when buffered bytes (`pending_writes` + the unsent tail of `active_send`)
≥ the mark, and sets `want_drain`. When the buffer empties, the native layer fires a **`drain`**
transition the JS `net.Socket` re-emits as `'drain'` (currently `net.js` emits no `drain`, so a
caller honoring `false` would wait forever; Slice 1b adds the native→JS path).
The **drain transition** is reentrancy-safe (rev.3 — the `'drain'` listener may write ≥ HWM
again or `destroy()`): (1) **clear `want_drain` before** emitting; (2) emit `'drain'`; (3) after
it returns, if `closing` stop, else **recompute** buffered bytes → `read_paused`, and only then
`maybe_arm_recv(conn)`. So a recv is never armed against fresh backpressure or after a reentrant
close, and no stale `want_drain` triggers a spurious future `'drain'`. Reads pause (`read_paused`,
not re-armed) only while buffered ≥ the mark, bounding memory against a slow reader.

### Teardown
- `net_close_conn(conn, had_error)` (proactor): **`conn.had_error |= had_error` FIRST** (rev.3 —
  sticky, before the idempotency guard, so a fatal completion's `net_close_conn(true)` after a
  reentrant `destroy()`→`net_close_conn(false)` is not lost to `false`); return if already
  `closing`; else set `closing`; **`shutdown(fd, SHUT_RDWR)`** to reliably wake a recv/send pending on an idle peer
  (Major 5 — `cancel_op` is best-effort: it silently no-ops if no SQE is free, so it cannot be
  relied on to produce `-ECANCELED`; the shutdown forces the pending op to complete); then
  `cancel_op(recv_op)`/`cancel_op(send_op)` for promptness; drop from the registry; **call
  `maybe_free(conn)`** (Major 6 — a conn at `inflight == 0`, e.g. after a peer-EOF half-close or
  a failed first submit, has no CQE/disposer to trigger reclaim otherwise). Do NOT close the fd,
  fire `on_close`, unprotect, or free here.
- `maybe_free(conn)`: returns unless `closing && inflight == 0`. Then finalize **in this order**
  (Major 7): `close(fd)` FIRST; if not `silent_close`, fire `on_close(had_error)` and unprotect
  the handlers (so the close event reports only after the socket is truly closed); `delete`
  `recv_buf`/`active_send`/`pending_writes`; `free(conn)`. Single free site; reached exactly once
  (at `inflight == 0`, after which no completion can call it again).

### Loop destruction with live proactor connections
`net_shutdown_active` (pre-destroy, no JS) iterates a **snapshot** of the registry (so freeing
mid-iteration can't invalidate it) and for each proactor conn: marks `closing` + `silent_close`,
unprotects handlers, `shutdown(fd, SHUT_RDWR)`, then **calls `maybe_free(conn)`** (rev.3, Major):
a conn already at `inflight == 0` (e.g. after a peer EOF — no op left, hence no disposer) is
finalized immediately here, fixing a leak; a conn with live ops is a no-op now and is freed by
its op's `Op_Dispose` during `eventloop.destroy` (ring close cancels+drains → `on_op_dispose`
does `inflight -= 1` + `maybe_free`, silent). `maybe_free` removes the conn from the registry as
it frees, so by the time `eventloop.destroy` runs only live-op conns remain and no disposer ever
dereferences a freed registry entry. Disposers decrement immediately (no JS reentrancy at
destroy). Exactly one free per conn.

### Memory (Major 9)
A per-conn 16 KiB `recv_buf` is ~160 MiB at 10k connections — a real regression vs today's
transient stack buffer (~0 per idle conn). Slice 1b therefore trades idle-conn memory for the
read-side syscall win, and **Slice 2's provided-buffer ring is what reclaims it** (no per-conn
read buffer → the actual memory moat). The 1b `bench-http` mem/conn is expected to rise; the
moat is a Slice-2 result. (16 KiB is a measured starting point, tunable.)

### Safety invariants (verification checklist)
1. `recv_buf`, `active_send`, `pending_writes` outlive every op referencing them (freed only in
   `maybe_free` at `inflight == 0`); `active_send` is never resized/moved while submitted.
2. `recv_buf` is never handed to JSC no-copy — only per-chunk copies are.
3. The conn outlives its ops and its in-flight completion (decrement is the completion's last
   act); no completion dereferences a freed conn.
4. Exactly one free per conn: `maybe_free` finalizes only on the `inflight` 1→0 transition while
   `closing` (NOT idempotent — a call after `free(conn)` would itself be a UAF; the guarantee is
   single-reach, since `inflight == 0` means no op remains to call it again).
5. JS handlers fire only while `!closing`, except `on_close`, which fires once at finalization
   after the fd is closed (and is suppressed on silent shutdown).
6. `-ECANCELED` is teardown (never a socket error), and transient `-EINTR`/`-EAGAIN`
   completions are retried (re-submit), not surfaced as fatal — only other negatives close the
   connection.
7. Failed submits are not counted (no inflated refcount / stalled conn); they fall back or close.
8. Teardown always reaches `maybe_free`, and a pending op on an idle peer is woken by
   `shutdown(SHUT_RDWR)` so it cannot pin the conn/loop forever.
9. Backpressure is high-water-based with a real `drain` event; reads pause only above the mark.
10. At most ONE recv is ever in flight per conn — `maybe_arm_recv` (the single arm site) never
    submits while `recv_op` is live, after `read_done` (EOF), while `read_paused`, or while
    `closing`; two recvs into the one `recv_buf` is impossible.
11. The connection's path is chosen by the explicit `io_mode` (set only after a successful first
    submit), never inferred from `proactor_available` or op-ID liveness (both IDs are invalid
    after EOF on a live proactor conn).
12. `active_send`/`pending_writes` stay `[dynamic]byte` and are rotated (not reallocated) so their
    allocator/capacity are preserved across sends; `had_error` is sticky; the `drain` transition
    clears `want_drain` before emitting and re-checks `closing`/buffered state after.
13. `net_shutdown_active` finalizes zero-inflight conns itself (no orphaned leak) and iterates a
    registry snapshot; no disposer dereferences a freed registry entry.

### Gates / tests (Major 10)
A test-only **require-proactor** mode asserts a connection actually used the proactor (CI must
not silently exercise only readiness), plus a **forced-readiness** run for the fallback. Cases:
retained JS data buffers (no overwrite/double-free), realloc of `pending_writes` during an active
send, synchronous `socket.destroy()` from each of on_data/on_end/on_error, partial sends, a
failed submission, close after peer EOF (zero-inflight reclaim), loop destruction with 0/1/2 ops
in flight, cancel races, drain semantics, and bounded memory with a slow peer. **Rev.3 reentrancy
cases:** a `write` ≥ HWM while a recv is already in flight, with the send completing first (must
NOT spawn a second recv into `recv_buf`); EOF arriving while `read_paused` (must not re-arm); a
`'drain'` listener that writes ≥ HWM again (read must not resume against fresh backpressure); a
`'drain'` listener that `destroy()`s (no recv submitted after close); a fatal completion whose
`on_error` listener calls `destroy()` first, asserting `'close'` reports `hadError === true`; and
`net_shutdown_active` over a zero-inflight conn (not just a normal close). Plus `bench-http`
(throughput up, mem/conn noted as regressed pending Slice 2), the `scribbleFreeCells +
collectContinuously` crash guard, net+http smokes on the proactor path, and an adversarial
multi-lens review.

### Platform (Minor 12)
The fallback is **Linux** epoll/io_uring readiness. `node:net` is Linux-only; macOS/Windows
have empty bindings (`net_other.odin`) and still report `node:net` unavailable — proactor vs
readiness is a Linux-internal choice. Non-Linux compile checks are retained to catch shared-type
regressions.

## Slice 2 — provided-buffer ring + multishot RECV (detailed design, rev. 2)

The memory moat. Slice 1b gave every proactor connection its own 16 KiB `recv_buf` (~160 MiB at
10k idle keep-alives). Slice 2 draws reads from a **shared** kernel buffer ring, so an idle
connection holds **no** read buffer. Rev. 2 incorporates an adversarial design review (6 Critical
+ 8 Major + 4 Minor); the headline change is that **2a and 2b are now sharply separated** because
multishot (2b) is incompatible with the per-CQE op accounting and must rework three layers, while
2a delivers the entire memory moat with one-CQE-per-op semantics the existing code already gets right.

- **Slice 2a — provided-buffer ring, SINGLE-SHOT `BUFFER_SELECT` recv.** The moat. One CQE per op
  (exactly like 1b), so the op-slot / `active_io_count` / net `inflight` accounting is UNCHANGED —
  only *where the buffer comes from* changes (shared ring, not per-conn). Lowest blast radius;
  ship first.
- **Slice 2b — multishot recv (`RECVSEND.MULTISHOT`).** One submission, many CQEs — the remaining
  per-request submit cut. Requires `F_MORE` threaded through Op_Completion, the drain op-branch,
  and the net handler so the op/slot/refcounts release exactly once on the terminal CQE. Higher
  risk; separate PR, only after 2a is proven.

### ABI (define ourselves; mirror the kernel — `core:sys/linux` exposes opcodes/flags/CQE bits +
`io_uring_register`, NOT these structs; same as `Uring_Probe` in 1a)
- `Uring_Buf_Reg` (io_uring_buf_reg, **40 B** — `#assert(size_of == 40)`): `ring_addr: u64,
  ring_entries: u32, bgid: u16, flags: u16, resv: [3]u64`, in EXACTLY this field order. It MUST be
  zero-initialized: `flags = 0` selects the **user-allocated-ring** path (we pass `ring_addr`); we
  deliberately do NOT set `IOU_PBUF_RING_MMAP`. `resv` MUST be all-zero — the kernel `-EINVAL`s a
  reg with unknown flag bits or non-zero resv (the same zeroing trap as `Uring_Probe`). On any
  non-`.NONE` register errno, fall back (no moat, no crash).
- `Uring_Buf` (io_uring_buf, **16 B** — `#assert(size_of == 16)`): `addr: u64, len: u32, bid: u16,
  resv: u16`.
- The ring is `ring_entries` × `Uring_Buf`; the kernel **overlays the producer `tail` (u16) on the
  first entry's `resv` (byte offset 14..15 of the ring)**. `ring_entries` is a power of two; `mask
  = ring_entries - 1`.
- The SQE `buf_group`/`buf_index` are a `#raw_union` (same offset); set **`buf_group` only** for
  `BUFFER_SELECT`.

### Buffer-id decode (the ABI text must be implementable)
`cqe.flags` is `bit_set[IO_Uring_CQE_Flags_Bits; u32]`, NOT an integer — `cqe.flags >> 16` does
not compile. Decode: `f := transmute(u32)cqe.flags; has_buf := .BUFFER in cqe.flags; bid := u16(f
>> 16)`. A `res > 0` CQE WITHOUT the `BUFFER` bit selected no buffer — treat as an error (do not
read `pool[bid]`). Always validate `bid < N`.

### Pool + ring setup (loop init, gated)
- Pool: `N` buffers × `M` bytes (start `N = 256`, `M = 16 KiB` → 4 MiB, **independent of conn
  count**; tunable). One contiguous allocation; `bid` → `pool[bid*M : bid*M + M]`.
- Ring: **page-aligned** (`mmap(MAP_ANON)` or `posix_memalign(PAGE_SIZE, N*16)`) — the kernel
  `-EINVAL`s a non-page-aligned `ring_addr` on the user-ring path; alignment is MANDATORY, not
  advisory. Assert `ring_addr % PAGE_SIZE == 0` before register. (The pool has no alignment need.)
- Seed: write all `N` buffers `Uring_Buf{addr=pool+bid*M, len=M, bid=bid}` then publish `tail = N`
  with a **release** store.
- The CQ ring depth must be **>= N** (`IORING_SETUP_CQSIZE`): a full ring of buffers can produce up
  to `N` completions; CQ overflow drops CQEs and the buffers they carried are leaked from the pool.

### Buffer recycle (the dominant Slice-2 lifetime rule)
**Any CQE that carried a buffer recycles its `bid`, regardless of connection state** — before the
`closing` check, before any delivery decision. Recycle is a pure pool op (no JS reentrancy), so it
is always safe, including during teardown. Recycle = write the buffer's three fields at
`bufs[tail & mask]` then release-store `tail+1`. **At ring index 0, write only the 14 bytes
addr/len/bid — never a 16-byte struct store — so the overlaid `tail` (bytes 14..15) is not
clobbered.** This closes the dominant leak: a data CQE that lands after `net_close_conn` (the
cancel/shutdown race) must still return its buffer, or the ring bleeds one buffer per torn-down
connection and eventually wedges every connection on `-ENOBUFS`.

### Completion handling (single-shot 2a)
1. Decode `has_buf`/`bid`/`res`. If `has_buf && bid < N`: **recycle `bid` immediately** (rule
   above). If `res > 0`, ALSO copy `pool[bid][:res]` into a JSC-owned `Uint8Array` (never no-copy)
   for delivery.
2. Then, if `!conn.closing`: `res > 0` → `on_data`; `res == 0` → EOF (`on_end`); `res == -ENOBUFS`
   → starved (below); other `res < 0` (not `-ECANCELED`) → `on_error` + close. Re-arm a fresh
   single-shot recv unless paused/EOF/closing (1b's `net_maybe_arm_recv`, now arming a ring recv).
3. The copy must precede `on_data`; the recycle precedes everything. One CQE per op, so the op slot
   / `active_io_count` / `inflight` release exactly as in 1b — **no accounting change in 2a**.

### `-ENOBUFS` — event-driven refill, never a spin (2a)
On `-ENOBUFS` the kernel picked NO buffer; a ring-mode conn holds none of its own, so there is
nothing for IT to recycle — the ring refills only when OTHER conns' data CQEs recycle. So do NOT
immediately re-arm into a known-empty ring (a re-arm storm that never progresses). Instead: park
the conn on a **recv-starved list** and re-arm it from the recycle path — when any recycle makes
the ring non-empty, drain the starved list (re-arm those conns). Track a simple `available` count
(++ on recycle, -- on a BUFFER-flag delivery) to drive it. Size `N >= expected concurrent active
connections`; document that an undersized `N` degrades to latency (parking), not a busy-loop. The
`-ENOBUFS` stress test asserts **bounded CPU** (no spin), not just "no drop/hang".

### Multishot (2b) — the three-layer `F_MORE` change
A multishot op stays armed across many CQEs (`IORING_CQE_F_MORE` set) and ends on the CQE that
clears it (normal end, error, `-ENOBUFS`, or a `cancel_op`/`shutdown` result). The op, its slot,
`active_io_count`, the net `recv_op`, and the net `inflight` are each **one-per-op** and must
release/clear **exactly once, on the terminal (`F_MORE`-clear) CQE** — never per intermediate CQE.
The current code does the opposite, so 2b must change three layers:
1. **Op_Completion signature** gains the terminal flag (and the buffer id): e.g.
   `Op_Recv_Completion(loop, user_data, res, bid: u16, has_buf: bool, more: bool)`. Without `more`
   reaching the callback, the lifetime decision is impossible.
2. **`drain_uring_completions` op-domain branch**: decode `more`/`bid` FIRST; fire the callback
   always; call `uring_op_release_slot` + decrement `active_io_count` ONLY when `!more`. On
   intermediate CQEs leave the slot `in_use` and the counter untouched. (Today it releases +
   decrements on every CQE → after the 1st multishot CQE the slot is freed/gen-bumped, later CQEs
   are dropped as stale, and `active_io_count` underflows → the loop can exit while a multishot is
   armed: the #72/#286 premature-exit class.)
3. **net `on_recv_complete` (`.ProactorRing` multishot)**: on an `F_MORE`-set CQE, copy + `on_data`
   + recycle but do NOT clear `recv_op`, do NOT `net_maybe_arm_recv`, do NOT `net_op_finished`
   (no `inflight--`). Only on the `F_MORE`-clear CQE: clear `recv_op`, then re-arm (a NEW multishot
   op) or close, and `net_op_finished` once. (Leaving `recv_op` set across intermediates also makes
   `net_maybe_arm_recv`'s `recv_op != INVALID` guard prevent the double-arm.)
- **A terminal CQE can still carry data**: ALWAYS recycle + (if `res>0`) copy+deliver based on
  `has_buf`/`res`, THEN separately act on `!more`. Never skip the final chunk/buffer.
- **`-ENOBUFS` is a terminal (`F_MORE`-clear) CQE** for multishot: run the terminal accounting
  (release slot, drop `active_io_count`+`inflight` once), then re-arm via the starved-list refill —
  not an immediate resubmit into an empty ring.

### Integration with 1b + fallback
- The per-conn mode is decided at the **first submit only** (like 1b): if the first ring recv can't
  be submitted, allocate a per-conn `recv_buf` and fall back to `.Proactor` (1b single-shot), then
  `.Readiness` — never strand a `.ProactorRing` conn with no buffer. A mid-life SQ-full re-arm uses
  the existing submit-and-retry; only error+close if that also fails (so a transient SQ-full does
  not kill live connections).
- `.ProactorRing` drops `recv_buf`; the send path (active_send/pending_writes) and teardown are
  unchanged from 1b (the multishot op still counts as one `inflight` until its terminal CQE;
  `cancel_op` + `shutdown(SHUT_RDWR)` end it with an `F_MORE`-clear CQE).

### Safety invariants (verification checklist)
1. Ring + pool memory is never freed while registered; `UNREGISTER_PBUF_RING` runs at loop destroy
   AFTER the ring is drained, before the pool is freed.
2. A pool buffer is kernel-owned while in the ring or in flight, ours ONLY between its completion
   and its recycle; never written while available/in-flight; never handed to JSC no-copy.
3. **Every CQE that carried a buffer recycles its `bid` exactly once, regardless of conn state**
   (closing/error/EOF); `bid` is validated `< N`; a `res>0` CQE without the `BUFFER` bit is an
   error, not a `pool[bid]` read.
4. The producer `tail` is advanced with a release store from the single loop thread; an index-0
   recycle writes 14 bytes and never clobbers the overlaid tail.
5. `-ENOBUFS` never drops a conn and never spins: starved conns park and are re-armed from the
   recycle path; `N` is sized for concurrency.
6. (2b) op slot, `active_io_count`, net `recv_op`, and net `inflight` each release/clear exactly
   once, on the `F_MORE`-clear CQE — never per intermediate CQE; a terminal CQE still recycles +
   delivers any buffer it carried.
7. All 1b connection invariants still hold (inflight refcount, single free site, reentrancy
   guards, teardown); 2a changes only the buffer source.

### Gating / tests
Probe `REGISTER_PBUF_RING` (≈5.19) and, for 2b, multishot recv (`RECV_MULTISHOT` ≈5.19/6.0);
fall back 2b→2a→1b→readiness. `#assert` the struct sizes (a layout error is a compile failure,
not a silent fallback). Tests: extend the `LAVA_NET_FORCE_READINESS` dual-mode smokes to also
force-1b-single-shot so CI exercises all read paths; a buffer-id decode + index-0-recycle (tail
survives) unit test; an `-ENOBUFS` stress (more concurrent live buffers than `N`) asserting buffer
conservation (seeded == in-ring + in-flight + held) AND bounded CPU; a multishot flood test
(many segments on one conn) asserting no pool leak and no CQ overflow; the crash guard; and
`bench-http` **mem/idle-conn**, where the moat must show idle memory dropping to ~Bun levels (well
below 1b's per-conn 16 KiB). An adversarial multi-lens review as for 1a/1b.
