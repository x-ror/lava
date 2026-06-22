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
`net_flush`). So per request the kernel is entered roughly twice on each side: once to learn
the fd is ready (poll), once to move the bytes (recv/send).

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
- **SEND**: submit `IORING_OP_SEND`; the completion reports bytes sent. Removes the readiness
  re-arm dance for backpressure.
- **Multishot RECV + provided-buffer-ring** (the memory win): one submission yields many
  completions, each naming a kernel-picked buffer from a *shared* ring. An idle keep-alive
  connection then holds **no** per-connection read buffer — the buffer is only consumed when
  data actually arrives. This is the moat: memory-per-idle-connection drops below Node/Bun.

## ABI status (Odin `core:sys/linux`)

- `IORING_OP.{RECV,SEND,RECV_MULTISHOT}`, `RECVSEND.MULTISHOT`, `IOSQE.BUFFER_SELECT`,
  `REGISTER_PBUF_RING`/`UNREGISTER_PBUF_RING`, `IORING_OFF_PBUF_RING`, and the SQE
  `buf_group`/`buf_index` fields are all present — the kernel ABI is fully exposed.
- The `uring` package has `recv`/`send`/`recvmsg`/`sendmsg` helpers, but `provide_buffers`
  and `read_multishot` are **empty stubs** — the buf-ring setup/recycle plumbing is ours to
  write (Slice 2). No missing kernel headers; just unwritten helpers.

## Safety model (the part that must be right)

This is completion-mode kernel I/O against JS-owned and native buffers; the lifetime rules
are the whole ballgame (the M2 crash was a buffer-lifetime bug — see
`http-server-concurrency-crash`).

1. **Op identity = generation token, never a pointer.** Every submitted op carries a token
   from an op-slot table (same design as `Uring_Watch_Slot`). A completion maps back through
   the table; if the connection was torn down (slot released, generation bumped) the
   completion is dropped without touching freed memory. Sentinels (wakeup=1, cancel=2) stay
   reserved; op tokens are `>= 1<<32`.
2. **A submitted buffer is pinned until its completion.** For RECV the destination buffer
   (per-conn in Slice 1, ring-owned in Slice 2) must outlive the op. For SEND the *source*
   bytes must outlive submission — so SEND copies into (or pins) a per-op buffer owned by the
   connection's write state, freed only on the SEND completion. No JS-owned `Uint8Array`
   backing is handed to the kernel and then released before completion.
3. **Teardown defers buffer reclaim, not just the struct.** `net_close_conn` already defers
   the `Net_Connection` free; in proactor mode it must also keep any in-flight op buffers
   alive until their completions drain (or are cancelled via `ASYNC_CANCEL` + generation
   bump). On loop destroy, in-flight buffers are reclaimed after the ring is drained/closed.
4. **Provided buffers are kernel-owned while armed.** A ring buffer is ours to read only
   between its completion and our recycle of it; we never free ring memory while the ring is
   registered. `-ENOBUFS` (ring momentarily empty) re-arms after refill rather than dropping
   the connection.
5. **Feature-gate + fallback.** Multishot recv and PBUF_RING need a recent kernel (≈5.19+/6.0).
   Probe at init; fall back to Slice-1 single-shot, then to the readiness path, then to epoll.
   `make bench-http` + the `JSC_scribbleFreeCells + collectContinuously` crash guard run on
   every slice.

## Slices (each its own PR, benchmark- and crash-gated)

- **Slice 1 — single-shot RECV/SEND completion path for net connections.** Adds an op-slot
  table + `submit_recv`/`submit_send` eventloop primitives and a `Net_Connection` proactor
  mode (per-conn recv buffer). Throughput win (poll+recv → recv); no memory change yet.
  Behind a capability flag, coexisting with the readiness path; fetch and other fds unchanged.
- **Slice 2 — provided-buffer-ring + multishot RECV.** The memory moat: shared buf_ring,
  `BUFFER_SELECT`, completion→buffer-id decode, recycle, `-ENOBUFS` re-arm. Target: lowest
  mem/idle-conn of the three runtimes, verified by `make bench-http`.
- **Slice 3 — send-side scaling.** SEND batching / `MSG_ZEROCOPY` for large bodies;
  `SO_REUSEPORT` + per-core acceptors for multi-core throughput.

## Non-goals (for now)

Windows/macOS proactor (Linux-first; those stay on their current backends). Replacing the
readiness path for fetch/file fds — the proactor is opt-in per connection-class.
