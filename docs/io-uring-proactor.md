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

## Slice 1b — wiring net connections onto the proactor (detailed design)

Slice 1a landed the eventloop primitive (`submit_recv`/`submit_send`/`cancel_op`, op-slot
table, `Op_Dispose`). Slice 1b makes `node:net` connections USE it: a connection becomes a
**full proactor** connection (recv op + send op, no readiness watcher) when
`proactor_available`, else stays on the current readiness path (`watch_fd` + `linux.recv`/
`net_flush`). Gating is per-connection so the two models never mix on one fd.

### Connection state (proactor mode)
Added to `Net_Connection`: `proactor: bool`, `recv_buf: []byte` (one `NET_READ_CHUNK` buffer,
allocated at start, freed at conn free), `recv_op`/`send_op: eventloop.Op_ID`, `inflight: int`
(submitted-but-not-completed ops), `read_paused: bool`. Existing `write_queue`,
`end_after_drain`, `closing` are reused; the readiness-only `watcher`/`writing` are unused in
proactor mode.

### Read lifecycle
- `net_start_cb` (proactor): allocate `recv_buf`; `recv_op = submit_recv(fd, recv_buf, on_recv_complete, on_op_dispose, conn)`; `inflight += 1`.
- `on_recv_complete(loop, conn, res)`: `inflight -= 1`; `recv_op = invalid`. Then:
  - if `conn.closing` → `maybe_free(conn)` (free when `inflight == 0`); deliver nothing.
  - `res > 0` → `on_data(recv_buf[:res])`; if a data handler closed the conn, stop; else re-arm
    `submit_recv` UNLESS a send op is in flight (write-backpressured) — then set `read_paused`
    (flow control: don't read faster than we can write, matching the readiness model's
    pause-reads-while-writing).
  - `res == 0` → peer half-close: `on_end`; do NOT re-arm (true half-close; write side stays
    open until the app closes).
  - `res < 0` and not `-ECANCELED` → `on_error` + `net_close_conn`. (`-ECANCELED` is our own
    teardown; just let `maybe_free` run.)

### Write lifecycle
- `net_write_cb` (proactor): append to `write_queue`; if no send op in flight, `send_op =
  submit_send(write_queue[:], on_send_complete, on_op_dispose, conn)`, `inflight += 1`.
  Backpressure signalled to JS = a send op already in flight (bytes still queued).
- `on_send_complete(loop, conn, res)`: `inflight -= 1`; `send_op = invalid`. Then:
  - if `conn.closing` → `maybe_free(conn)`.
  - `res > 0` → drop `res` bytes from the front of `write_queue`; if more remain, submit the
    remainder (`inflight += 1`); else drained → if `read_paused`, re-arm recv and clear it; if
    `end_after_drain`, `net_close_conn`.
  - `res < 0` (not `-ECANCELED`) → `on_error` + `net_close_conn`.
  Partial sends are thus handled by re-submitting `write_queue[res:]` — never freeing it early.

### Teardown (the safety-critical part)
- `net_close_conn` (proactor): set `closing`; fire `on_close` + unprotect the four handlers
  ONCE (so later cancelled completions, which run with `closing` set, never call JS); remove
  from the registry; `cancel_op(recv_op)` and `cancel_op(send_op)`. Do NOT close the fd or free
  the conn yet.
- Each cancelled op still produces a terminal CQE (`-ECANCELED`) that runs `on_recv_complete`/
  `on_send_complete` with `closing` set → `inflight -= 1` → `maybe_free`.
- `maybe_free(conn)`: when `closing && inflight == 0`, close the fd, `delete(write_queue)`,
  `delete(recv_buf)`, drop from the registry, `free(conn)`. This is the single free site; the
  kernel has produced terminal CQEs for both ops, so it will never touch `recv_buf`/the send
  bytes again. (Replaces the current `async_begin`+`post_async` deferred free, which existed
  because an in-flight readiness callback might still read `conn.closing`; the proactor's
  refcount subsumes that — the conn outlives its ops by construction.)

### Loop destruction with live proactor connections
`net_shutdown_active` runs in eval's pre-destroy teardown, BEFORE `eventloop.destroy`. For a
proactor conn it must NOT free directly (an in-flight op still references it): it sets
`closing`, unprotects handlers, and leaves the conn. Then `eventloop.destroy` →
`platform_destroy` closes the ring (kernel cancels+drains the ops) and runs each op's
`Op_Dispose` = `on_op_dispose(conn)`, which does `inflight -= 1` + `maybe_free`. So proactor
conns are freed by the dispose path; readiness conns keep the current direct free. Exactly one
free per conn.

### Safety invariants (to verify)
1. `recv_buf` and `write_queue` outlive every op that references them — both freed only in
   `maybe_free`, which runs only at `inflight == 0`.
2. The conn outlives its ops (the `inflight` refcount); no completion ever dereferences a freed
   conn.
3. Exactly one free per conn (`maybe_free` guarded by `closing && inflight == 0`, idempotent).
4. JS handlers (`on_data`/`on_end`/`on_error`/`on_close`) fire only while `!closing`.
5. `-ECANCELED` is distinguished from a real socket error (no spurious `on_error`).
6. Flow control: reads pause while a send is backpressured (`read_paused`), matching the
   readiness model, so a slow reader can't make the server buffer unboundedly.

### Gates
`make bench-http` (throughput + mem/conn — the read-side win lands here) reported before/after;
the `JSC_scribbleFreeCells=1 JSC_collectContinuously=1` crash guard; net + http smokes pass
with the proactor path active (they will, since io_uring is present in CI); plus an
adversarial multi-lens review of the teardown/refcount, as for 1a.
