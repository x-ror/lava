# Designing a High-Performance Linux Event-Loop Runtime
### Consolidated design notes for a Node.js alternative (Linux-first MVP)

This merges two independent analyses into one build-oriented spec. Both converge on a single principle, so state it up front: **millions of HTTPS requests are not handled by "an event loop." They are handled by a whole system in which every byte, allocation, queue, timeout, and ownership transition is deliberately controlled.** The event loop is necessary but not where the wins live — they live in buffer ownership, backpressure, allocation discipline, the kernel interface, and the native/JS boundary.

Language is intentionally out of scope here (deferred by decision). The only language-relevant conclusion both analyses share: **ownership architecture decides performance, not the language.** Bad code in a "fast" language loses to good code in a "slow" one. Pick the language later; get the architecture right now.

---

## 1. Architecture first: per-core, shared-nothing workers

Do **not** design "one global loop handles everything." Design N independent workers, each pinned to a CPU core, each owning its world with no shared mutable state on the hot path:

```text
supervisor / master
  ├── worker 0  → event loop pinned to core 0
  ├── worker 1  → event loop pinned to core 1
  └── worker N  → event loop pinned to core N

each worker owns:
  listening socket (SO_REUSEPORT) or its accepted connections
  epoll / io_uring instance
  timer queue
  connection slab + fd→connection table
  buffer pools / free lists
  TLS contexts
  HTTP parser state
  JS isolate/runtime  +  callback / nextTick / microtask queues
  stream queues
  per-core allocator/heap
```

**Connection distribution.** Use `SO_REUSEPORT` (one listening socket per worker, kernel hashes new connections across them) rather than a central acceptor that becomes a bottleneck. On modern kernels this plus `EPOLLEXCLUSIVE` removes the need for the old accept-mutex patterns. A central acceptor that hands fds to workers is the fallback if you need custom steering logic.

**Scaling model — the tradeoff to decide.** Shared-nothing thread-per-core (the Seastar model) pins each loop to a core, gives each its own memory and connections, and communicates between cores only via lock-free SPSC queues. This eliminates locks and cache-line bouncing and scales near-linearly. Its weakness is load imbalance — a few very hot connections stuck on one core — mitigated by connection steering/migration or simply accepting it. The alternative, work-stealing (Go/Tokio style), balances load better but pays synchronization and cache-locality costs. For a from-scratch high-performance runtime, start shared-nothing.

**Sharded JS runtimes.** One JS isolate/runtime per worker, no shared JS heap across workers. This keeps the per-core isolation intact all the way up into user code and avoids cross-core GC coordination.

---

## 2. The I/O core: epoll now, io_uring as the fast path — behind one interface

Put the I/O backend behind an abstraction and ship two implementations. This is the path libuv itself took.

```text
runtime/event_loop/
  loop.*
  poller_epoll.*
  poller_io_uring.*   ← added later, same interface
  timer.*
  task_queue.*
  connection.*
  stream.*
```

**Start with epoll (Reactor model).** The kernel signals readiness; you then issue `read`/`write`. Use **edge-triggered** mode (`EPOLLET`) for fewer wakeups, but then you **must drain each fd until `EAGAIN`** — edge-triggered reports state *transitions*, not persistent readiness, so a partial read can leave you blocked with data still buffered. Add `EPOLLONESHOT` for multi-threaded fd handling and `EPOLLEXCLUSIVE` on shared listeners. epoll's ready-set retrieval is O(1) and scales to millions of fds; its cost is one syscall per operation, which is the tax io_uring later removes.

**Add io_uring later (Proactor/completion model).** Two memory-mapped rings (submission + completion) shared with the kernel let you submit work and reap results with few or zero syscalls. The features that matter most, in payoff order:

- **Provided buffer rings** (`IORING_REGISTER_PBUF_RING`) — the single biggest memory win. Instead of dedicating a receive buffer to every connection, you hand the kernel a pool and it consumes one only when data actually arrives, reporting which buffer it used. At hundreds of thousands of mostly-idle connections this is the difference between bounded and ruinous memory.
- **Multishot operations** (`accept`, `recv`, `poll`) — submit once, get a stream of completions; eliminates per-event resubmission on accept and read paths. Designed precisely for servers accepting many connections and reading long-lived ones.
- **SQPOLL** — a kernel thread polls your submission ring, so userspace submits I/O with zero syscalls. Trades a busy kernel thread (a burned core) for syscall elimination: a direct CPU-for-latency deal.
- **Registered files/buffers** (`READ_FIXED`/`WRITE_FIXED`), **linked SQEs** (`IOSQE_IO_LINK`) to chain read→write without a userspace round trip, **`SEND_ZC`** for zero-copy transmit, and **`DEFER_TASKRUN` + single-issuer** to shave kernel overhead in single-threaded-per-ring designs.
- io_uring also makes **file I/O genuinely async**, which epoll cannot (regular files always report "ready"), reducing the need for an offload thread pool for disk.

**Three crucial caveats.**
1. **Newer ≠ automatically faster.** Naive "replace epoll with io_uring" frequently fails to improve anything; the wins come from *architectural* use (multishot, provided buffers, batching), not the API alone. Research on high-performance systems adopting io_uring has shown exactly this. Benchmark before committing.
2. **Deployment/security.** io_uring has had a steady stream of CVEs and is disabled in many sandboxed/hardened environments (ChromeOS, gVisor, some container runtimes). Your epoll backend is also your portability and correctness reference.
3. **Lifetime danger.** Buffers handed to the kernel for read/write must stay valid until completion. Enforce explicit ownership states on every buffer:

```text
FREE → USER_OWNED → KERNEL_OWNED → TLS_OWNED → JS_OWNED → (back to FREE)
```

Mismatched ownership is the classic io_uring bug class; make it a typed state, not a convention.

Per worker, also create an **`eventfd`** for cross-thread wakeups and either a **`timerfd`** or an internal timer structure (see §3).

---

## 3. The loop cycle and scheduling

Model the cycle on libuv's phases, with JS integration woven in:

```text
timers           → fire expired timers
pending callbacks
idle / prepare
poll             → block in epoll_wait/io_uring (timeout = next timer)
check            → setImmediate-style
close callbacks
microtasks / nextTick   → JS integration each turn
```

Note recent libuv (1.45+, shipped in Node 20) processes timers **after** the poll phase rather than before and after — match that ordering if you want Node parity, but don't copy Node perfectly at first; expose Node-compatible behavior only where tests require it.

A clean epoll loop skeleton:

```text
while running:
    now = update_time()
    run_due_timers(budget)
    drain_internal_tasks(budget)
    drain_nexttick_queue(budget)
    drain_microtasks(budget)

    timeout = compute_poll_timeout()        # until next timer
    events  = epoll_wait(timeout, max_events)

    for ev in events:
        conn = ev.user_data
        if ev.readable:        read_until_eagain(conn)
        if ev.writable:        flush_until_eagain(conn)
        if ev.error_or_hangup: close_connection(conn)

    run_check_phase()
    run_close_callbacks()
    recycle_buffers()
```

**Fairness budgets (mandatory).** An event loop runs each callback to completion — there is no preemption, so one hot connection or one long callback can starve everything. Bound work per tick:

```text
MAX_READ_BYTES_PER_TICK   = 256 KB
MAX_WRITE_BYTES_PER_TICK  = 256 KB
MAX_CALLBACKS_PER_TICK    = 1000
MAX_MICROTASKS_PER_TICK   = 1000
```

For truly CPU-bound user work, offload to a thread pool rather than relying on budgets alone.

**Timers: heap now, timing wheels at scale.** A binary min-heap (O(log n) insert, O(1) peek) is the right MVP choice and what libuv uses. But a runtime wants a timeout *per connection* — millions of timers, mostly inserted/cancelled rather than fired. For that, switch to **hierarchical timing wheels** (Varghese–Lauck): O(1) amortized insert and expiry with far better cache behavior, at the cost of bucketed granularity and some fixed slot memory. This is the algorithm in the Linux kernel timer subsystem, Kafka, and Netty's `HashedWheelTimer`. Heap for the MVP; wheels once connection-timeout volume dominates.

---

## 4. The connection is a state machine

Every accepted socket becomes a compact object advanced through explicit states:

```text
Connection {
  fd; state; flags; last_active_time
  tls_state; http_state; stream_state
  read_buffer_chain; write_queue; request_queue
}

states:
  ACCEPTED → TLS_HANDSHAKE → READING_HEADERS → READING_BODY
           → APP_RUNNING → WRITING_RESPONSE → KEEP_ALIVE_IDLE → CLOSING
```

The pipeline, with a hard rule:

```text
TCP read → TLS decrypt → HTTP parse → request/body stream
         → JS handler → response stream → HTTP encode → TLS encrypt → TCP write
```

**Never** model this as "read the whole request into memory, then call JS." That destroys streaming and memory behavior. Advance the state machine incrementally as bytes arrive.

---

## 5. Buffers and streams — where most performance is won or lost

**Avoid the bad hot path:** `read → malloc new buffer → copy → concat → parse → copy → JS Buffer`.

**Do this instead:** `read → reusable slab buffer → parse by pointer ranges → expose slices/views`.

Buffer machinery:

- **Size-class slab pools** (e.g. 4 KB/8 KB small, 16 KB/32 KB medium, `mmap`/malloc for large bodies), recycled per worker via free lists — kills the per-read malloc/free churn that is itself a top hotspot.
- **Buffer chains** (small vector or intrusive list of buffer refs) and **refcounted slices** `{buffer_id, offset, length}` so parsing never copies to join fragments.
- On the io_uring backend, **provided buffer rings** are the standout (see §2): no buffer per idle connection.

**Zero-copy — size-adaptive, not always-on.** Zero-copy shifts cost into page pinning and completion bookkeeping and only wins above a size threshold; for small messages a plain copy is faster. So:

- **Always** use scatter-gather `writev` to emit status line + headers + body chunks in one syscall with no concatenation.
- For plaintext proxying/static files: `splice` (socket→pipe→socket) and `sendfile` move data entirely in-kernel.
- For large transmits: `SEND_ZC` / `MSG_ZEROCOPY` (with a notification telling you when the buffer is reusable).
- For **encrypted** static content: **kTLS** lets `sendfile` work through TLS, the kernel doing the symmetric crypto inline — the bridge between zero-copy and HTTPS.
- Pair with `TCP_NODELAY` (latency) or `TCP_CORK`/`MSG_MORE` (coalesce small writes for throughput).

**Parsing — resumable, zero-copy, and SIMD.** The parser must be a resumable state machine that survives read boundaries (a header can split across reads). Beyond that:

- Return **slices/views** into the read buffer for header values; copy only when JS needs a stable, escaping string.
- **SIMD/SWAR acceleration** is a real, unconventional win: picohttpparser uses SSE to scan delimiters; the simdjson approach (multiple GB/s) generalizes. Use SIMD or SWAR (SIMD-within-a-register on plain 64-bit words) to find `\r\n` boundaries and validate tokens.

**Backpressure is mandatory.** The system dies not because epoll is slow but because queues grow unbounded. Every layer needs a high-water mark: socket read buffer, TLS-decrypted buffer, HTTP body stream, JS readable queue, response write queue, TLS-encrypted output, kernel send buffer. The core rule:

```text
if conn.write_queue_bytes > HIGH_WATER: disable_read_interest(conn)
if conn.write_queue_bytes < LOW_WATER:  enable_read_interest(conn)
# then: pause upstream stream, apply timeout, eventually close slow clients
```

This protects memory *and* improves latency, because the loop stops reading data it can't yet process.

---

## 6. Memory strategy: controlled memory for fewer allocations

The willingness to "trade memory for speed" is correct **as long as it's bounded**. Trade *controlled* memory for fewer allocations; never trade *unbounded* buffering.

- **Arena / region allocation per request** is the highest-impact idea. Allocate everything a request needs (headers, parser metadata, small temporaries) from a bump-pointer arena and free the whole arena in one shot when the request completes: O(1) allocate, O(1) bulk free, no fragmentation, excellent locality. You may hold slightly more than strictly needed at any instant — that's the bounded "sacrifice."
- **Object pools / free lists** for recycled structures (connection objects, buffer headers, task nodes); **per-core heaps** so there are no global allocator locks on the hot path.
- **Cache-line discipline:** align hot structures to 64 bytes, pad shared counters to avoid false sharing between cores, and consider struct-of-arrays layout for connection metadata you scan in bulk (e.g. keep all "next timeout" fields contiguous for cache-friendly timer scanning).
- **NUMA:** allocate a connection's memory on the node of the core handling it. **Hugepages** for large buffer pools to cut TLB misses.

```text
GOOD trade:  more pooled memory, far fewer malloc/free calls
BAD  trade:  unbounded request buffering
```

---

## 7. The JS ↔ native boundary (the part specific to a Node alternative)

This boundary is where a runtime is made or lost, and it's mostly absent from generic "fast server" advice.

- **Core rule:** native owns the bytes; JS sees views; copy only when JS mutates data or lets it escape the native lifetime.
- **`Buffer` design:** back it with an external `ArrayBuffer` over the native buffer; increment a native refcount while the JS object lives; a finalizer decrements it. No copy on the common path.
- **Lazy JS object creation:** don't materialize full request/response JS objects until user code actually touches them. Most requests never inspect most fields.
- **Header interning:** turn common header names (`content-type`, `content-length`, `connection`, `host`) into interned symbols rather than fresh strings.
- **Precomputed responses:** store prebuilt byte slices for common replies (`400`, `404`, `413`, `500`) and for hot routes.
- **Fast paths:** a specialized path for `GET` with no body, keep-alive, known headers, and a small response will dominate real traffic — optimize it end to end.
- **Two stream layers:** a fast, simple native engine (`{queue, high_water_mark, consumer, paused, eof, error}`) underneath, and a JS compatibility layer (`ReadableStream`/`WritableStream`/`node:stream`/`fetch` body) on top. Pull when the consumer is ready; push only up to the high-water mark; propagate cancel/error/close through the whole pipeline.

---

## 8. TLS / HTTPS strategy

**Do not implement crypto yourself.** Use OpenSSL (3.5 is an LTS with server-side QUIC support and long support runway) for the easiest Node parity; BoringSSL (fast, but less API-stable), rustls (memory-safe, modern), or s2n-tls are alternatives behind a provider abstraction you add later.

**Integration must be nonblocking.** Wire the socket fd to the TLS state machine to the plaintext HTTP stream. If `SSL_read`/`SSL_write` returns want-read/want-write, register the corresponding interest and return to the loop — the handshake must never block it.

**Termination choice.** If you front the runtime with a TLS-terminating tier (cloud LB, Envoy, nginx) so it speaks plaintext internally, the in-process TLS burden disappears and you keep only raw socket handling. But a Node *alternative* generally needs in-process TLS for parity, so plan the nonblocking integration above as the default, and treat `sendfile`+**kTLS** (§5) as the route to zero-copy for encrypted static content.

---

## 9. The exotic tier — for the "unconventional methods" question (mostly post-MVP)

Real options, with the honest note that most are research projects inside your project and will slow the MVP:

- **Kernel bypass:** `AF_XDP` (raw frames to userspace via an eBPF program at the driver) or **DPDK** (poll-mode drivers, the NIC owned by your process, no interrupts, hugepages). Either then needs a **userspace TCP stack** — mTCP, F-Stack (FreeBSD's stack ported), Seastar's native stack, or TLDK. Line-rate performance at the cost of burned cores and enormous complexity; appropriate for trading systems and CDN edges, not a general runtime MVP.
- **eBPF:** `sockmap`/`sk_msg` to splice socket-to-socket entirely in-kernel (great if you proxy), `XDP` for early in-kernel filtering/load distribution, and a BPF program attached to the `SO_REUSEPORT` group for smarter-than-default connection steering.
- **Busy-polling:** `SO_BUSY_POLL`, or io_uring `SQPOLL` — burn CPU to eliminate wakeup/interrupt latency. Pure latency-for-CPU.
- **Programming model:** stackful coroutines/fibers so handlers can "block" ergonomically while the runtime multiplexes underneath. Alibaba's **Photon** (coroutines married to io_uring) is the reference design for this combination — relevant because a pleasant Node alternative needs ergonomic async, not just a fast loop.

Explicitly **not** for MVP: DPDK, a custom TCP stack, custom TLS, full kernel bypass, hand-rolled crypto.

---

## 10. What can actually beat Node/Bun — and what can't

Your real edges:

```text
Linux-first, fewer abstraction layers
modern kernel APIs (io_uring backend)
tighter JS/native boundary, fewer copies across it
less JS object allocation per request, better Buffer pooling
per-core architecture from day one
fetch/HTTP pipeline optimized as one unit
less legacy compatibility weight
```

What will **not** help: "we wrote epoll ourselves, therefore it's faster." libuv is mature, single-threaded-per-loop, and already picks the best platform mechanism (epoll/kqueue/IOCP). General-purpose compatibility is hard to beat; your win is being narrower, more Linux-native, and tighter at the boundary — not reinventing the multiplexer.

---

## 11. Concrete MVP build order

```text
 1. TCP server with epoll
 2. per-core workers with SO_REUSEPORT
 3. connection slab + buffer pools
 4. nonblocking OpenSSL TLS
 5. HTTP/1.1 parser (resumable, zero-copy slices)
 6. response write queue + writev
 7. backpressure (watermark chain)
 8. timers / timeouts (min-heap)
 9. JS callback integration
10. Node-like streams
11. benchmarks + flamegraphs   ← gate before optimizing further
12. io_uring backend (multishot, provided buffers)
13. HTTP/2
14. kTLS / SEND_ZC experiments; timing-wheel timers
15. HTTP/3 / QUIC
```

Benchmark targets to track from early on:

```text
plain TCP echo            HTTPS many short connections
HTTP/1.1 plaintext        large static file
HTTPS keep-alive          small JSON response
streaming request body    streaming response body
slow-client defense (backpressure correctness)
```

---

## 12. Reference implementations worth studying

- **libuv** — the phase model and the epoll/io_uring backend abstraction.
- **Seastar** — thread-per-core, shared-nothing done rigorously.
- **Photon / Tokio** — coroutine and async runtimes layered over io_uring.
- **picohttpparser / simdjson** — SIMD parsing in practice.
- **mTCP / F-Stack** — userspace TCP stacks, if you ever go down the kernel-bypass road.
- **nginx** — the buffer model (memory/file refs with `pos`/`last`/`file_pos` and temporary/memory/file/flush/recycled flags) and the worker-as-state-machine design.
- **Cloudflare Pingora** — a real-world, very-high-throughput programmable network service to study for production patterns.

---

## The one principle to keep

Measure relentlessly — at this level intuition is often wrong, and most of these levers are workload-specific (io_uring helps when used architecturally; zero-copy helps large transfers and hurts small ones; SQPOLL trades a core for latency). Build `perf`, flamegraphs, and eBPF tracing in from day one and let the profile choose which levers you pull. And remember the thing both analyses agree on: the performance lives in controlling every byte, allocation, queue, timeout, and ownership transition across the whole system — not in the event loop alone.

---

# Part II — Alternatives to the event-loop core itself

Part I assumes an event-loop core and optimizes around it. This part steps back: if we could replace the core of a runtime entirely — drop libuv's event loop and not be bound to any language or technology — what is the actual space of alternatives? This is language- and tech-agnostic by design.

## The core is a scheduling model, and the event loop is one point in a space

A runtime's "core" is really its execution and scheduling model: how a unit of concurrency is represented, who schedules it onto hardware, and how it interacts with I/O and with other units. The event loop is one specific point in that space, and the space is defined by a few axes.

**Cooperative vs preemptive scheduling** is the most important axis and the event loop's biggest weakness. The event loop is cooperative: each callback runs to completion, so one bad callback stalls everything. A preemptive core (OS threads, Go's scheduler, BEAM's reduction counting) guarantees fairness — no task can starve the others.

**Shared memory vs isolation.** Shared mutable memory with locks (threads) versus shared-nothing message passing (actors, processes). This determines whether data races are even possible and how you scale across cores.

**Blocking ergonomics vs explicit async.** The event loop forces non-blocking code or offloading. Fibers and virtual threads let code *look* blocking while staying efficient, removing the "function coloring" problem where `async` infects every signature.

**Readiness vs completion** (reactor vs proactor — epoll vs io_uring/IOCP) and **scheduling topology** (single-thread vs work-stealing vs thread-per-core) round out the space.

Plotting the well-known cores on the two dominant axes:

```text
                     isolated state
                           |
        Seastar  o         |         o  Erlang / BEAM
   (thread-per-core)       |       (actors + supervision)
                           |
   cooperative ------------+------------ preemptive
    scheduling             |             scheduling
                           |
      Node.js o  o Deno    |    o JVM Loom    o Go
   (libuv event loop)      |   (virtual thr.)  (goroutines)
                           |
                     shared memory
```

The event loop sits in the cooperative + shared-memory corner. The interesting alternatives move you rightward (gain preemptive fairness) and/or upward (gain isolation and fault tolerance). Erlang/BEAM sits in the opposite corner — the most different core from the event loop, and arguably the most robust for connection-heavy systems.

## The families of alternative cores

**Preemptive lightweight-task schedulers** are the most compelling alternative, in two schools. The Go school uses shared memory, channels, a work-stealing scheduler, and asynchronous preemption — cheap goroutines give true multicore parallelism, but data races remain possible because the language doesn't forbid them. The BEAM/Erlang school uses isolated lightweight processes, each with its own heap and garbage collector, preemption by reduction counting, message-passing-only communication, plus supervision and a "let it crash" philosophy. BEAM is probably the most robust core ever built for systems with millions of connections — WhatsApp held roughly two million connections per server on it — at the cost of lower per-core throughput and message-copying overhead.

**Virtual threads, fibers, and effects** give blocking ergonomics without losing efficiency. Java's Loom maps millions of virtual threads onto a few carrier threads, with code written in straight-line blocking style and a poller underneath. OCaml 5 goes further: effect handlers implement lightweight cooperative fibers as a language construct, and domains provide parallelism. For JS this would remove function coloring entirely. The caveat: the engine must be able to suspend and resume an arbitrary call stack, which V8 cannot do today (though WebAssembly stack-switching and JSPI are moving in that direction).

**Thread-per-core, shared-nothing** (Seastar, Glommio) is not a different concurrency model but a different parallelism topology: one executor per physical core, nothing shared between cores, communication via lock-free queues, each core with its own loop. It gives near-linear scaling and zero cross-core synchronization, and it can be combined with any of the models above as the per-core model. Alongside it, the **completion-based async runtime** (Tokio over io_uring) is a work-stealing scheduler of stackless tasks on completion I/O — Deno is the living example, using V8 with Tokio instead of libuv.

At the frontier sit **kernel-bypass run-to-completion** (DPDK — dedicated cores spin-poll and the loop never sleeps), **structured concurrency** as a scheduling discipline (scopes own the lifetime of their child tasks, with cancellation and errors propagating structurally — a principle, not a different engine), and a **distributed actor core** where an actor can be local or remote and the runtime is natively distributed, which is the logical choice if "millions of requests" inherently spans multiple machines.

## Synthesis and the honest meta-point

Choosing a core is choosing a position on these axes, and libuv's event loop is one specific corner: cooperative scheduling, one thread per isolate, shared memory within the isolate, explicit async, reactor I/O. Given the freedom to rewrite a runtime's core, the highest-impact moves are: add preemption (kills "one bad callback stalls everything"); make the unit isolated and supervised (kills shared-state bugs, adds fault tolerance); give blocking ergonomics via virtual threads or effects (kills function coloring); move to thread-per-core (topology); and move to completion I/O.

The honest crux: every real JS runtime still uses an event-loop-shaped core not because better cores don't exist — BEAM, Go, and Loom are arguably better general-purpose concurrency models — but because JavaScript's own semantics (single thread per isolate, shared mutable memory within an isolate, no preemption points, no stack switching) were designed around the event loop. Changing the core therefore means either changing the language's semantics or building a fundamentally different engine. Unbound by language, the real alternatives are exactly that: a JS-like language whose engine supports preemptible, isolated, stack-switching, message-passing tasks — effectively "JS on BEAM" or "JS with virtual threads," not a variation on the same event loop.

---

# Part III — Concretely: these cores as a JS-runtime core

Two of the alternatives above are worth making concrete, because they are the two realistic directions for a JS runtime that wants to move past the event loop: a BEAM-style isolated-actor core and a virtual-thread core. For each: what the execution model looks like, what a server looks like on it, and what would have to change in the engine and in the language.

## A. A BEAM-style isolated-actor core

The idea is to replace "one isolate, one event loop, one shared mutable heap" with many lightweight, isolated JS processes, each with its own tiny heap and GC, scheduled preemptively across a pool of per-core scheduler threads, communicating only by message passing and organized under supervision trees.

**Execution model.** The unit of concurrency is a lightweight process — not an OS thread, not a callback — a cheap object with its own stack and its own small, independently collected heap. Spawning one costs microseconds and kilobytes, so millions are feasible. Processes never share mutable objects; to communicate, a process sends a message to another's mailbox, and the message is copied (or, for large immutable binaries, reference-counted off-heap as BEAM does). This eliminates data races by construction — there is no shared mutable state to race on. A small number of scheduler threads, one pinned per core, run the processes preemptively: each process runs for a bounded budget (BEAM counts reductions, roughly work units) and is then preempted so the scheduler can pick another. One runaway computation therefore cannot starve the rest — precisely the failure mode the cooperative event loop suffers from. Because each process owns a tiny heap, GC is local and short: you collect one process's heap without stopping the world, so there is no global GC pause across all connections — the latency cliff that pushes latency-sensitive services off globally-collected runtimes. I/O still runs through a poller (epoll/io_uring) owned by the scheduler: when a process does a blocking-looking receive, the scheduler parks it and runs others, then marks it runnable when the I/O completes. The event loop becomes an internal detail of the scheduler rather than the programming model; each process is written as straight-line, blocking-looking code. Finally, processes live in supervision trees: when one crashes it dies in isolation (its heap is discarded, and because nothing was shared, no corruption leaks), and its supervisor restarts it per a strategy — fault tolerance as a first-class property, so a crashed handler never takes down the runtime or other requests.

**A server on this core.** Each connection spawns a lightweight process that owns the connection end-to-end, written as straight-line blocking code — read request, await the database, write response — with no async/await coloring. Millions of connections become millions of cheap, preemptively scheduled processes, each with its own tiny heap. This is, almost exactly, the WhatsApp architecture.

**What the engine must change.** V8 is built around one isolate equal to one thread with one shared heap; you can run multiple isolates, but each is heavyweight (its own full heap and compiler state), so you cannot cheaply have millions. A true BEAM-style core needs a JS engine whose "process" is far lighter than a V8 isolate — a cheap-to-create, cheaply-collected heap-plus-stack that still runs JS — which is a fundamental engine redesign, not a libuv swap. It also needs preemption: V8 inserts no safe yield points into arbitrary JS execution, so the VM would have to add reduction-style bounded yielding into its execution loop. And it needs cheap per-process heaps with cheap inter-process copying, plus many tiny independently-collected heaps instead of V8's single per-isolate heap. In short, you are building a BEAM-class VM that happens to execute JS.

**What the language must change.** JS's shared-mutable-memory model (within an isolate) is replaced by share-nothing message passing: no shared globals across processes, communication by explicit messages. That is a real semantic shift — closer to Erlang/Elixir than to JS as it exists. `async`/`await` becomes largely unnecessary at the surface, since code in a process is straight-line blocking and the runtime suspends the whole process on I/O. You gain structured fault tolerance, no data races, no global GC pauses, and preemptive fairness; you give up shared-memory performance tricks and full compatibility with the existing JS ecosystem, which assumes a single shared heap and an event loop. The honest summary: this is Erlang/Elixir semantics with JS syntax — a new VM, not Node with a different loop.

## B. A virtual-thread core

The idea here is more conservative: keep JS's single-shared-heap-per-isolate semantics largely intact, but replace explicit async/await over an event loop with millions of virtual threads over a small pool of carrier OS threads, so JS can be written in straight-line blocking style while the runtime multiplexes it. This is the Loom model applied to JS.

**Execution model.** The unit of concurrency is a virtual thread — a JS execution context with its own suspendable call stack, cheap enough (kilobytes) to have millions. A small pool of carrier OS threads (about one per core) actually runs them. When a virtual thread blocks — reading a socket, awaiting a query, sleeping — the runtime unmounts it from its carrier (saving its stack), runs another, and remounts it when the operation completes, with the poller underneath signaling completion. The event loop is again an internal detail; the programmer writes blocking-looking code. The headline win is eliminating function coloring: no `async`/`await`, no red/blue function split, no Promise plumbing in signatures — a function that does I/O looks identical to one that does not, and `const rows = db.query(...)` blocks the virtual thread rather than the carrier. Whether scheduling is preemptive depends on the design: virtual threads yield at blocking points and ride on OS carriers the kernel can preempt, but a tight compute loop that never blocks can still monopolize a carrier unless the runtime adds safepoints.

**A server on this core.** Each connection runs one virtual thread executing straight-line blocking handler code. Millions of connections become millions of virtual threads on a few carriers — the same scaling as the event loop, but the code reads like synchronous thread-per-request code.

**What the engine must change.** The engine must be able to suspend and resume an arbitrary JS call stack at any blocking point — capture the whole stack, park it, and restore it later, possibly on a different carrier. V8 cannot do this today: its stack is tied to the OS thread and it has no general continuation mechanism for arbitrary JS frames. (Generators and async are stackless coroutines: they suspend only at explicit `yield`/`await` by transforming the function into a state machine, and cannot suspend a deep call stack at an arbitrary point.) The relevant building block is stack switching — and there is active work on WebAssembly stack-switching and on JSPI (JavaScript Promise Integration) that provides a limited form of suspending a call stack across a boundary; a full virtual-thread core would need general, cheap stack-switching for JS frames as an extension of that direction. This is more incremental than the BEAM rewrite — it keeps the heap, GC, and object model — but it still requires a real engine capability V8 lacks, plus a scheduler and poller (the Loom-equivalent of a fork-join pool and NIO) in place of libuv's loop.

**What the language must change.** Far less than the BEAM model. JS keeps its single shared heap per isolate, its GC, and its object model; the main change is that blocking becomes allowed and cheap, suspending only the virtual thread rather than the world, and `async`/`await` becomes optional/legacy while idiomatic code goes straight-line. The one genuine tension is parallelism versus races: if virtual threads run truly in parallel on multiple carriers and share objects, you reintroduce data races — something JS never had to worry about as a single-threaded language. Loom lives with this because Java already has shared-memory threads and a memory model; JS does not. So the cleanest JS-flavored version uses virtual threads for concurrency and ergonomics (no coloring) but keeps execution single-threaded per isolate — only one virtual thread runs at a time — and gets parallelism the way Node already does, through multiple isolates/workers. That preserves JS's no-data-races guarantee and removes async coloring, at the cost of no intra-isolate parallelism.

## Which to pick

The BEAM-style core offers maximum robustness — supervision, no races, no global GC pauses, preemptive fairness — but it is effectively a new VM with new semantics (JS-flavored Erlang) that breaks ecosystem compatibility; it fits when fault tolerance and massive connection counts dominate and leaving the JS ecosystem is acceptable. The virtual-thread core offers maximum compatibility — it keeps JS semantics, removes async coloring, and needs "only" engine-level stack switching — fitting when you want Node-like JS with synchronous-style code and without rewriting the language, the open question being parallelism versus races.

Both share the same deep move, which is the real answer to "an alternative to the event loop": you do not remove the loop, you demote it from the programming surface to the basement and put a better concurrency model — preemptive isolated processes, or virtual threads — on top of it.