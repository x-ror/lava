# Multi-core workers (Slice 3a) — design (review before impl)

Status: **DRAFT for review** — revised after an adversarial design review (8 critical / 10 high / 7
medium / 3 low). The core approach was validated; this revision closes the gaps it found.

**Scope:** `SO_REUSEPORT` + per-core worker event loops — the Node `cluster` / Bun shared-nothing
model. This is the largest remaining throughput lever: on a 16-core box we use **one** core today
(~34–53k req/s single-loop vs Node/Bun 100k+ multi-core). The completion-mode `node:net` rewrite
(Slices 1–2) is the foundation it needs.

**`MSG_ZEROCOPY` is explicitly deferred to Slice 3b (a separate fast-follow PR).** The review showed
its two-CQE (`result` + `IORING_CQE_F_NOTIF`) lifetime is **not** a net-layer tweak — it violates the
single-terminal-CQE op invariant at four layers (drain dispatch, op-slot release, `active_send`
rotation, teardown/inflight) and needs its own eventloop-layer two-CQE op primitive (depth comparable
to multishot-RECV in 2b). It carries most of the correctness risk (a premature buffer rotate = the
kernel reading freed memory onto the wire) while contributing nothing to the headline benchmark
(hello-world / tiny bodies are unaffected by ZC by design). Bundling it would couple a kernel-UAF
revert to the multi-core win. → 3b gets its own design doc. See §8.

---

## 1. The model is forced by JSC: shared-nothing workers

A `JSGlobalContext` is **thread-affine** — usable only on its creating thread, and a JS heap cannot
be shared across threads. So "use more cores" means **N independent workers**, each a
`{ event loop + JSC context + Runtime_State }` running the app independently, with the kernel
load-balancing connections across them via `SO_REUSEPORT`. Shared-nothing: no shared JS heap, no
cross-worker locks on the hot path.

**User-visible contract** (documented, opt-in): the app runs N times. Stateless request handlers (the
overwhelming majority) are unaffected. In-process shared state (a global counter, an in-memory cache)
is per-worker — coordination must be external (Redis, DB), exactly as with Node `cluster`. Multi-core
is **opt-in, never automatic** (auto would silently break single-instance assumptions).

---

## 2. Validated finding: state is already per-`Runtime_State`

The decisive (review-confirmed) fact: **almost all mutable runtime state already lives in
`Runtime_State`** (`globals.odin:14-80`), stored on each context's global-object private slot and
recovered via `get_state_from_ctx` (`globals.odin:180`). One context per worker ⇒ giving each worker
its own `Runtime_State` isolates nearly everything for free:

| State | Location | Under N workers |
|---|---|---|
| `loop`, timers, async queue, platform I/O | `globals.odin:15` | own per worker — natural |
| `module_cache`, `builtin_require`, `esm_transform`, `error_intrinsics` | `globals.odin:26-35` | own per worker — context-specific GC roots |
| `net_servers`, `net_conns`, `net_starved_*`, `next_net_id` | `globals.odin:67-75` | own per worker (per-worker `net_servers` keyed registry — no global "the listener fd") |
| `sqlite_*`, `active_fetches`, `pending_free` | `globals.odin:52-63` | own per worker |
| `script_argv` | `globals.odin:79` | read-only after init — shareable |

So the rewrite is *spawn N workers, each doing what `main` does today, under `SO_REUSEPORT`* — plus a
**now-complete** list of true process-globals (§3). That list is the real risk surface.

---

## 3. Process-globals — the complete list (corrected after review)

The review's independent grep found my first list missed several. Full enumeration:

### 3.1 Must fix — racy lazy init (N workers race the unsynchronized check-then-set)
All have the same defect (a `if g == nil { g = create() }` with no synchronization) and the same fix
(**guard with `sync.Once`**, preserving lazy creation; the *value* is safe to share once built):

| Global | File | Why shareable once built |
|---|---|---|
| `perf_initialized` / `perf_origin_tick` / `perf_time_origin_ms` | `globals.odin:711-716` | a shared monotonic origin is *desirable* (comparable `performance.now()` across workers) |
| `g_fetch_cancel_class` / `_resume_` / `_push_` / `_end_class` | `fetch.odin:183,221,258,260` | `JSClassRef` is context-group-independent |
| `g_tls_ctx` (`SSL_CTX`) | `tls.odin:92-93` | `SSL_CTX` is refcounted, safe to share once built (OpenSSL 1.1+ self-init is thread-safe) |
| `net_force_readiness_state` | `net.odin:357` | benign (idempotent test-only `getenv`); fold into bring-up for tidiness |

Fix shape: a `sync.Once` per lazy getter (or one bring-up `runtime_process_init` that eagerly creates
the always-needed ones; TLS/fetch stay lazy-via-Once to avoid loading the trust store for apps that
never do https). Reads are safe-by-happens-before: each worker's `install_performance` /
first-fetch runs the `Once` before its user code touches the value.

### 3.2 Verified safe under N workers (no action — recorded so review needn't re-chase)
`ERROR_INTRINSIC_NAMES`, `fs_mkdtemp_alphabet` are `@(rodata)`; `core:net` `dns_config_initialized`
is already a `sync.Once`; `tls_darwin` anchors are Darwin-only stubs (Linux-first).

### 3.3 Console interleaving
`console_raw_write` (`globals.odin:596-606`) writes whole strings to `os.stdout`/`stderr` unbuffered;
N workers can interleave mid-line. Fix: a **process-global** (file-private) `stdout`/`stderr` mutex
around the write so each line is atomic. (A writer thread is more machinery than warranted.)

### 3.4 `process.exit()` semantics
`process.exit`/`os.exit` (`globals.odin:636-663`) exits the whole process immediately. Under N
workers any worker calling it kills all siblings, bypassing graceful drain and diverging from Node
cluster (where a worker's exit ends only that worker). **Decision (documented): `process.exit()` =
whole-process exit** — simplest, and matches a thread-based (not process-based) worker model. Noted as
an explicit divergence from Node cluster.

---

## 4. DNS resolver pool — **per-worker (Option B)**

Reversed from the draft's "shared (Option A)". The review showed a shared `g_fetch_dns_pool` is
unsound without a concurrency rewrite: `outstanding` (`fetch_dns_pool.odin:64,88,198`) and
`started`/`stopping` are documented **loop-thread-only, lock-free** — true for one loop, a data race
(heap corruption on the fetch path) across N loops; and `fetch_dns_pool_shutdown` is reached from
*every* worker's teardown (`destroy_runtime_state → fetch_shutdown_active`, three call sites), so the
first worker to exit joins all DNS threads and frees siblings' in-flight jobs → cross-worker UAF.

**Decision: move the pool into `Runtime_State` (per-worker).** This preserves the loop-thread-only
invariant *verbatim*, needs no locking of `outstanding`, and the existing teardown works unchanged
(each worker joins its own 4 threads before its `eventloop.destroy`, satisfying `destroy`'s
"all off-loop producers joined" precondition at `loop.odin:215-219`). Cost: up to 4×N DNS threads —
but **lazy** (spawned only on first DNS use; a pure HTTP server never spawns them) and idle/blocking.
This also matches `Loop.pool` (the generic fs/crypto thread pool, `threadpool.odin:75`), which is
already per-loop. Removes an entire class of cross-thread reasoning from the impl + review.

---

## 5. `SO_REUSEPORT` + the listen/accept path

Each worker runs the app, so each independently calls `server.listen` → `net_listen_cb`
(`net.odin:138-242`). Insertion point is clean: socket→setsockopt→bind (`net.odin:169-206`) leaves
room to set `SO_REUSEPORT` right after the existing `SO_REUSEADDR` (`net.odin:176`), **before** bind.

Rules (all gated on worker-count > 1; single-worker is byte-for-byte unchanged):
- **Uniform**: set `SO_REUSEPORT` on **every** TCP listener the runtime creates (not just the first),
  so a multi-server app (8080 + 9090) can't hit `EADDRINUSE` from a partial group.
- **`listen(0)` / ephemeral (critical fix)**: N workers each binding port 0 would get N *different*
  ports — silently N single-core servers. **The supervisor pre-resolves one ephemeral port** (bind a
  temp `SO_REUSEPORT` socket on 0, `getsockname`, close) and injects the concrete port so every
  worker binds the *same* real port. `server.address().port` (`net.odin:977`, `getsockname` on the
  worker's own fd) is then consistent across workers. *(Open: dynamically-created servers on port 0
  can't all be pre-resolved — under multi-worker we require fixed ports for additional dynamic
  servers, or fall back to single-worker for them. See §9.)*
- **Late/partial bind**: a worker that still gets `EADDRINUSE` (staggered `listen`) must surface it as
  a normal `Server` `'error'` event — **not** a fatal worker death that trips the crash policy and
  tears down healthy workers.

**Known limitations (documented, not fixed in 3a):**
- *Head-of-line under skew*: `SO_REUSEPORT` hashes by 4-tuple, not by load. A worker stuck in a long
  handler/GC fills its 511-deep backlog and the kernel still routes its hashed SYNs there → resets
  while peers idle. Acceptable for v1; the bench plan adds a skewed-load test so we measure it.
- *Graceful-shutdown SYN drops*: closing a `REUSEPORT` listener drops SYNs already queued to it (the
  kernel doesn't redistribute them). Mitigation: on shutdown, stop arming new accepts but **drain the
  backlog (`accept` until EAGAIN)** before closing; document that a small reset window may remain.

---

## 6. Worker lifecycle (concrete)

- **Supervisor / workers**: main becomes the supervisor; spawns N worker threads (`core:thread`),
  each running the **existing `eval()`/`run_file()` unchanged** on its own thread — this is critical:
  `eval()` already encodes the load-bearing teardown LIFO (dispose hooks fire against a *live* JSC
  context, then `JSGlobalContextRelease`, `runtime.odin:126-166`). We inject the stop check **only
  inside `eventloop.run`**, never reimplement teardown. `N==1` runs inline exactly as today (no new
  threads → CLI/non-server unaffected).
- **Two-phase startup barrier**: each worker signals `ready` (bound + context up) or `failed` to the
  supervisor before entering `run()`. Under fail-fast, any `failed` makes the supervisor stop+wake+join
  all ready workers and exit non-zero — the *same* teardown path as graceful shutdown (one path, not
  two). Covers JSC-init / thread-create / bind failures and partial-spawn cleanup.
- **Stop flag**: an **atomic** `stop` on `Loop` (or a wrapping `Worker`). Supervisor does
  `atomic_store(stop, true)` **then** `wakeup(loop)` (store-before-wake, matching `post_async`'s
  lock-publish-then-wake; the wakeup pipe already breaks a parked poll —
  `URING_WAKEUP_USER_DATA`/`EPOLL_WAKEUP_TOKEN`). `run()`'s condition becomes
  `has_pending_work && !backend_error && !atomic_load(stop)` — required because a listening server
  keeps `active_io_count > 0` forever, so the loop never exits on its own.
- **Graceful drain**: on stop, unwatch listeners + drain their backlog, let in-flight conns finish
  (existing `net_shutdown_active` / op cancellation), then exit. Per-worker DNS jobs drain naturally
  because the per-worker pool (§4) joins at the worker's own teardown — no job posts into a freed loop.
- **Signals**: block `SIGINT`/`SIGTERM` in workers via `pthread_sigmask` (inherited from the
  supervisor blocking them before spawn); the supervisor uses **`signalfd`/`sigwait`** (not a handler)
  — sidesteps async-signal-safety entirely; on signal it sets each worker's stop flag + wakeup. Today
  only `SIGPIPE` is touched (`signals_posix.odin`), so this is greenfield.
- **Crash policy**: one worker exiting abnormally → supervisor tears the rest down + exits non-zero (a
  crash is usually a deterministic app bug all workers share; auto-restart is out of scope).

---

## 7. Opt-in API — worker count

- **`LAVA_WORKERS=<n>`** env: unset/`1` → today's single-loop path (no threads); `auto` → `nproc`;
  integer → that many. The app is responsible for being cluster-safe (documented), as with Node
  `cluster`. (`auto` = `nproc`; the supervisor is near-idle so it needn't reserve a core.)
- Alternatives noted for review: a `--workers` CLI flag (env is container-friendlier); a Bun-style
  lazy `reusePort` option on `listen` (more magical, larger surface) — deferred. A JS `cluster` module
  is out of scope.

---

## 8. Slice 3b (zerocopy) — deferred, summarized for context

A separate fast-follow PR with its own design doc. It must build a **first-class two-CQE op primitive**
in the eventloop layer: a `submit_send_zc` whose slot survives until the `IORING_CQE_F_NOTIF` CQE (not
the result CQE), an `Op_Completion` variant distinguishing result-vs-notif, `active_io_count` counted
until the NOTIF, drain dispatch that classifies `F_NOTIF` (distinct from the multishot-RECV `F_MORE`
path that also keys off `cqe.flags`), and a per-op owned send buffer (not the rotated `active_send`
pair) so each in-flight ZC op pins its own allocation. Plus a size threshold (~16 KiB) and a
capability fallback. None of this is in 3a.

---

## 9. Open questions for review
1. **`listen(0)` for dynamically-created additional servers** under multi-worker: require fixed ports,
   or degrade those to single-worker? (Primary server's port 0 is handled by supervisor pre-resolve.)
2. **Opt-in**: `LAVA_WORKERS` env (recommended) vs `--workers` flag?
3. **HOL/skew**: accept the `REUSEPORT` backlog tradeoff for v1 (recommended) vs add BPF steering now?
4. Resolved (recording the decisions): DNS → per-worker (§4); crash → fail-fast tear-down (§6);
   `auto` → `nproc` (§7); `process.exit()` → whole-process (§3.4); console → process-global mutex.

---

## 10. Test & verification plan
- **Unit (eventloop)**: `SO_REUSEPORT` bring-up; supervisor spawn/join + two-phase barrier; atomic
  stop-flag + wakeup breaks a parked poll; per-worker DNS pool teardown joins before loop destroy.
- **Global-init races**: stress N workers starting simultaneously (perf clock, fetch classes, TLS
  ctx) — assert single init, no corruption; N workers logging concurrently → every line intact.
- **Integration**: N-worker HTTP under `autocannon` — throughput **scales** with workers (headline);
  connections distribute; `server.address().port` identical across workers (incl. `listen(0)` after
  supervisor pre-resolve); staggered `listen` doesn't crash a late worker; **skewed-load** test (HOL);
  graceful shutdown **measures connection resets**, not just response correctness; both proactor &
  readiness modes; `process.exit()` from one worker.
- **Crash guard**: existing GC-stress guard per worker / multi-worker.
- **Cross-platform**: darwin/windows compile-only (workers Linux-first; stubs elsewhere).
- **Adversarial review (pre-merge)**: §3 global completeness re-audit, shutdown/teardown races across
  N loops, `SO_REUSEPORT` correctness (port 0, multi-server, late bind), per-worker DNS lifetime.

## 11. Commit staging (one 3a PR)
1. §3 process-global fixes (`Once` for perf clock / fetch classes / TLS ctx; console mutex;
   `process.exit` doc) — independently safe, single-worker behaviour unchanged.
2. DNS pool → per-worker (move into `Runtime_State`; teardown unchanged).
3. Supervisor + worker spawn/join + two-phase barrier + `LAVA_WORKERS`; `N==1` stays inline.
4. Atomic stop flag + `eventloop.run` integration + `signalfd` supervisor + graceful drain.
5. `SO_REUSEPORT` listener gating + supervisor port-0 pre-resolve + late-bind error handling.
6. Tests + docs.
