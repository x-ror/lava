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

Rev. 2 incorporates the design review (PR #287): 3 Critical + 7 Major + 2 Minor, fixed below.

Connections become **full proactor** (recv op + send op, no readiness watcher) when
`proactor_available`, else stay on the readiness path. Per-connection gated.

### Connection state (proactor mode)
- `recv_buf: []byte` — a per-conn **kernel landing zone** (NET_PROACTOR_RECV = **16 KiB**, not
  64 KiB). It is REUSED across recvs; its bytes are **copied** into a JSC-owned allocation per
  chunk and never handed to JSC no-copy (Critical 2 — `make_uint8_array` transfers ownership to
  JSC, which may retain/free it; reusing the buffer would overwrite an emitted Buffer and
  double-free). The per-conn allocation is a real idle-memory cost (Major 9) — see "Memory".
- Writes use **two** buffers (Critical 1 — an Odin `[dynamic]` append can realloc/free its
  backing while io_uring still holds the old pointer): `active_send: []byte` + `active_send_off:
  int` is the IMMUTABLE buffer currently submitted to a send op (never resized/moved/freed
  before its CQE); `pending_writes: [dynamic]byte` is the mutable queue appends land in. When no
  send is in flight, `pending_writes` is swapped into a fresh `active_send` and submitted.
- `recv_op`, `send_op: Op_ID`; `inflight: int` (op refcount); `read_paused: bool`;
  `want_drain: bool` (a drain event is owed); `closing`, `silent_close`, `had_error`, `end_after_drain`.

### Read lifecycle
- `net_start_cb` (proactor): alloc `recv_buf`; `id := submit_recv(...)`; if `id != OP_ID_INVALID`,
  `recv_op = id; inflight += 1`; **else fall back to the readiness path** for this connection
  (Major 4 — never count a failed submit).
- `on_recv_complete(conn, res)`: clear `recv_op`. If not `closing`:
  - `res > 0` → **copy** `recv_buf[:res]` into a fresh JSC-owned `Uint8Array` (the current
    per-chunk copy, Critical 2) and call `on_data`. If a handler did not close and reads are not
    paused, re-arm `submit_recv` (count only a valid id; on failure → error-and-close, Major 4).
  - `res == 0` → `on_end` (true half-close; do not re-arm).
  - `res < 0 && res != -ECANCELED` → `on_error` + `net_close_conn`.
- **End every completion with `op_finished(conn)`** = `inflight -= 1`; `maybe_free(conn)` — the
  LAST action, after all JS calls and all `conn.*` access (Critical 3). A synchronous
  `socket.destroy()` inside `on_data` sets `closing` and runs `maybe_free` while this op is still
  counted (`inflight >= 1` → no free); the conn is freed only when this completion's trailing
  decrement reaches 0. The inflight count IS the callback-held reference.

### Write lifecycle
- `net_write_cb` (proactor): append to `pending_writes`. If `send_op == OP_ID_INVALID`, swap
  `pending_writes` into `active_send` (move the backing; give `pending_writes` a fresh array),
  `active_send_off = 0`, submit; count only a valid id (on failure → error-and-close). Returns
  backpressure per the high-water rule below — NOT merely "a send is in flight" (Major 8).
- `on_send_complete(conn, res)`: clear `send_op`. If not `closing`:
  - `res > 0` → `active_send_off += res`. If `< len(active_send)` re-submit `active_send[off:]`
    (partial send; same backing, never moved — Critical 1). Else `active_send` is fully sent:
    if `pending_writes` is non-empty, swap+submit; else drained → free/reset `active_send`, and if
    `want_drain` emit **`drain`** (below); if `read_paused` re-arm recv; if `end_after_drain`
    close.
  - `res == 0` on a non-empty submission → no-progress → treat as error + close (Minor 11).
  - `res < 0 && != -ECANCELED` → `on_error` + close.
- Trailing `op_finished(conn)` as for reads.

### Backpressure & drain (Major 8)
Every io_uring send is asynchronous, so "a send is in flight" is NOT backpressure. Backpressure
is a **queued-byte high-water mark** (`writableHighWaterMark`, default 16 KiB): `net_write_cb`
returns `false` only when buffered bytes (`pending_writes` + the unsent tail of `active_send`)
≥ the mark, and sets `want_drain`. When the buffer later empties, the native layer signals a
**`drain`** transition the JS `net.Socket` re-emits as `'drain'` — currently `net.js` never
emits `drain`, so a caller honoring `false` would wait forever; Slice 1b adds the native→JS
drain path. Reads are paused (`read_paused`, recv not re-armed) only while buffered ≥ the mark,
bounding memory against a slow reader, and resumed when it drains.

### Teardown
- `net_close_conn(conn, had_error)` (proactor; idempotent on `closing`): set `closing`, stash
  `had_error`; **`shutdown(fd, SHUT_RDWR)`** to reliably wake a recv/send pending on an idle peer
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
`net_shutdown_active` (pre-destroy, no JS) marks each proactor conn `closing` + `silent_close`,
unprotects its handlers, and `shutdown(fd, SHUT_RDWR)` — but does NOT free (ops still reference
it). Then `eventloop.destroy` → ring close cancels+drains the ops → each op's `Op_Dispose`
(`on_op_dispose`) does `inflight -= 1` + `maybe_free`, which finalizes silently (fd close + free,
no `on_close`). Disposers decrement immediately (no JS reentrancy at destroy). Exactly one free.

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
4. Exactly one free per conn; `maybe_free` is idempotent and reached once.
5. JS handlers fire only while `!closing`, except `on_close`, which fires once at finalization
   after the fd is closed (and is suppressed on silent shutdown).
6. `-ECANCELED` is never surfaced as a socket error.
7. Failed submits are not counted (no inflated refcount / stalled conn); they fall back or close.
8. Teardown always reaches `maybe_free`, and a pending op on an idle peer is woken by
   `shutdown(SHUT_RDWR)` so it cannot pin the conn/loop forever.
9. Backpressure is high-water-based with a real `drain` event; reads pause only above the mark.

### Gates / tests (Major 10)
A test-only **require-proactor** mode asserts a connection actually used the proactor (CI must
not silently exercise only readiness), plus a **forced-readiness** run for the fallback. Cases:
retained JS data buffers (no overwrite/double-free), realloc of `pending_writes` during an active
send, synchronous `socket.destroy()` from each of on_data/on_end/on_error, partial sends, a
failed submission, close after peer EOF (zero-inflight reclaim), loop destruction with 0/1/2 ops
in flight, cancel races, drain semantics, and bounded memory with a slow peer. Plus `bench-http`
(throughput up, mem/conn noted as regressed pending Slice 2), the `scribbleFreeCells +
collectContinuously` crash guard, net+http smokes on the proactor path, and an adversarial
multi-lens review.

### Platform (Minor 12)
The fallback is **Linux** epoll/io_uring readiness. `node:net` is Linux-only; macOS/Windows
have empty bindings (`net_other.odin`) and still report `node:net` unavailable — proactor vs
readiness is a Linux-internal choice. Non-Linux compile checks are retained to catch shared-type
regressions.
