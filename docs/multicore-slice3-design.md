# Multi-core workers (Slice 3a) — design (review before impl)

Status: **IMPLEMENTED** (design merged in #293 after two adversarial review rounds; built here as the
staged commits in §11). The shared-nothing direction was validated; the lifecycle contracts
(stop/drain/barrier/supervisor) below are the ones the second review round tightened, and what the
implementation follows. End-to-end behaviour is covered by `make test-multicore-smoke`.

**Scope:** `SO_REUSEPORT` + per-core worker event loops — the Node `cluster` / Bun shared-nothing
model. The largest remaining throughput lever: on a 16-core box we use **one** core today (~34–53k
req/s single-loop vs Node/Bun 100k+ multi-core). The completion-mode `node:net` rewrite (Slices 1–2,
merged) is the foundation it needs.

**`MSG_ZEROCOPY` is deferred to Slice 3b (separate fast-follow PR).** Its two-CQE
(`result` + `IORING_CQE_F_NOTIF`) lifetime violates the single-terminal-CQE op invariant at four
layers (drain dispatch, op-slot release, `active_send` rotation, teardown/inflight) and needs its own
eventloop-layer two-CQE op primitive (depth ≈ multishot-RECV in 2b). Most of the correctness risk
(a premature rotate = kernel reading freed memory onto the wire), zero benefit to the hello-world
headline. → its own doc. See §8.

---

## 1. The model: shared-nothing workers, separate JSC VMs

JSC's C API is thread-safe, but callers **sharing one VM serialize** (a per-VM lock) — so *parallel*
execution requires **separate VMs**, not one VM touched from many threads. `JSGlobalContextCreate`
already creates a unique context group (VM) per call. So "use more cores" means **N independent
workers**, each a `{ event loop + JSC context/VM + Runtime_State }` running the app independently, the
kernel load-balancing connections across them via `SO_REUSEPORT`. Shared-nothing: no shared JS heap,
no cross-worker locks on the hot path. (The architecture is unchanged from the first draft; only the
*rationale* is corrected — it's serialization-avoidance, not a thread-ownership restriction.)

**User-visible contract** (documented, opt-in): the app runs N times. Stateless request handlers (the
overwhelming majority) are unaffected. In-process shared state is per-worker — coordinate externally
(Redis, DB), as with Node `cluster`. Multi-core is **opt-in, never automatic**.

**Linux-only, fail-fast.** Multi-worker depends on `SO_REUSEPORT`, `signalfd`, and the io_uring
proactor — all Linux. `LAVA_WORKERS>1` on darwin/windows is a **hard error** at startup (not a silent
single-worker degrade — that would violate deployment intent), consistent with the Linux-first
direction. Because no N-worker mode exists off Linux, the darwin/windows lazy globals that aren't
`Once`-guarded (e.g. `tls_darwin.odin`'s `g_extra_anchors_*`, `tls_darwin.odin:374-390`) are never
raced.

---

## 2. Validated finding: state is already per-`Runtime_State`

The decisive (review-confirmed) fact: **almost all mutable runtime state already lives in
`Runtime_State`** (`globals.odin:14-80`), stored on each context's global-object private slot and
recovered via `get_state_from_ctx` (`globals.odin:180`). One context per worker ⇒ giving each worker
its own `Runtime_State` isolates nearly everything for free:

| State | Location | Under N workers |
|---|---|---|
| `loop`, timers, async queue, platform I/O, `Loop.pool` | `globals.odin:15` | own per worker — natural |
| `module_cache`, `builtin_require`, `esm_transform`, `error_intrinsics` | `globals.odin:26-35` | own per worker — context-specific GC roots |
| `net_servers`, `net_conns`, `net_starved_*`, `next_net_id` | `globals.odin:67-75` | own per worker — no global "the listener fd" |
| `sqlite_*`, `active_fetches`, `pending_free` | `globals.odin:52-63` | own per worker |
| `script_argv` | `globals.odin:79` | read-only after init — shareable |

So the rewrite is *spawn N workers, each doing what `main` does today, under `SO_REUSEPORT`* — plus a
now-complete list of true process-globals (§3).

---

## 3. Process-globals — the complete list

### 3.1 Must fix — racy lazy init → `sync.Once` (value is safe to share once built)
| Global | File | Note |
|---|---|---|
| `perf_initialized` / `perf_origin_tick` / `perf_time_origin_ms` | `globals.odin:711-716` | shared origin is desirable (comparable `performance.now()`) |
| `g_fetch_cancel_class` / `_resume_` / `_push_` / `_end_class` | `fetch.odin:183,221,258,260` | `JSClassRef` is context-group-independent |
| `g_tls_ctx` (`SSL_CTX`) | `tls.odin:92-93` | refcounted, shareable; OpenSSL 1.1+ self-init is thread-safe |
| `net_force_readiness_state` | `net.odin:357` | benign (idempotent test-only `getenv`); fold into bring-up |

Each worker's `Once` runs before its user code reads the value (happens-before via the `install_*`
path), so reads need no atomics.

### 3.2 Verified safe (no action — recorded so review needn't re-chase)
`ERROR_INTRINSIC_NAMES`, `fs_mkdtemp_alphabet` are `@(rodata)`; `core:net` `dns_config_initialized` is
already a `sync.Once`. `tls_darwin.odin`'s `g_extra_anchors_*` are real lazy mutations but Darwin never
runs N workers (§1), so never raced.

### 3.3 Output interleaving — one global locked writer (all paths, not just `console`)
`console_raw_write` (`globals.odin:596-606`) is **not** the only stderr/stdout path: uncaught
exceptions (`globals.odin:383`) and internal init failures (`globals.odin:1088`) do their own writes.
N workers can interleave any of these mid-line. Fix: a single process-global locked writer that **all**
process output routes through, each assembled message written in **one** call under the lock.

### 3.4 `process.exit()` semantics
`process.exit`/`os.exit` (`globals.odin:636-663`) exits the whole process immediately. **Decision
(documented): `process.exit()` = whole-process exit** (simplest; matches a thread-based worker model;
an explicit divergence from Node cluster, where it ends only that worker).

---

## 4. Fetch DNS → the existing per-loop generic pool (not a new pool)

The draft proposed a per-worker DNS pool to fix the shared-pool races. The second round showed that
**doubles an already-duplicated pool**: every `Loop` already owns a 4-thread generic pool
(`threadpool.odin:7`, `Loop.pool`) explicitly described as *generalizing* fetch DNS, while
`fetch_dns_pool` adds its own 4 (`fetch_dns_pool.odin:33`). At `auto` on a 128-core box that's ~1000
auxiliary threads if both activate.

**Decision: retire `fetch_dns_pool`; route fetch DNS resolution through `eventloop.pool_submit`** (the
per-loop generic pool). This (a) makes DNS per-loop — preserving the loop-thread-only invariant that
made the shared pool unsafe under N loops — and (b) avoids the second pool entirely (one 4-thread pool
per worker, lazy). The generic pool gains **cancellable jobs** if DNS teardown needs to abort a queued
resolve; disposal/join stay centralized in the one pool the loop already tears down before
`eventloop.destroy` (satisfying its "all off-loop producers joined" precondition, `loop.odin:215-219`).

---

## 5. `SO_REUSEPORT` + the listen/accept path

Each worker runs the app, so each independently calls `server.listen` → `net_listen_cb`
(`net.odin:138-242`). Insertion point is clean: socket→setsockopt→bind (`net.odin:169-206`).

- **Set + check `SO_REUSEPORT`** right after `SO_REUSEADDR` (`net.odin:176`), before bind, on **every**
  TCP listener (not just the first), gated on worker-count > 1. Unlike the existing `REUSEADDR` call,
  its result **must be checked**: every member of a `REUSEPORT` group must set it successfully or the
  group is unsafe — surface the exact errno as a listener/startup error.
- **`listen(0)` is rejected under multi-worker** (clear error: "ephemeral port requires an explicit
  port under LAVA_WORKERS>1"). The supervisor cannot map JS `listen` calls to a shared port: "primary
  server" is undefined, and it doesn't know a listener's host/order or whether `listen(0)` is even
  synchronous — multiple top-level ephemeral listeners diverge as easily as dynamic ones, and
  "fall back to one worker" is impossible once N app instances exist. Tests that need an ephemeral port
  run single-worker (the default). *(A future listener-coordinator keyed by deterministic listener
  ordinal+address — with timeout + mismatch detection — could lift this; out of scope for 3a, §9.)*
- **Startup binds must all succeed or abort** (§6 barrier): a listener that fails to bind during
  startup is a *startup failure* reported to the supervisor, **not** a recoverable `Server` `'error'` —
  running with partial/partitioned capacity is worse than not starting. *Post*-startup, normal Node
  semantics resume (a handled `'error'` continues; an unhandled one terminates the worker → process,
  under §6's crash policy).
- **Known limitation — HOL under skew**: `REUSEPORT` hashes by 4-tuple, not load; a worker stuck in a
  long handler/GC fills its backlog and the kernel still routes its hashed SYNs there → resets while
  peers idle. Accepted for v1; the bench plan measures it (§10).

---

## 6. Lifecycle (concrete — the contracts the review tightened)

### 6.1 Workers run existing `eval()` + a pre-run hook
Each worker runs the existing `eval()`/`run_file()` teardown LIFO **unchanged** (it encodes the
load-bearing order: dispose hooks against a *live* context, then `JSGlobalContextRelease`,
`runtime.odin:126-166`). But `eval()` calls `eventloop.run` internally after top-level eval
(`runtime.odin:287-288`), leaving no point to report readiness. So `eval()` gains one seam: a
**pre-run callback** fired after top-level eval returns (listeners bound) and *before* `eventloop.run`.

### 6.2 Startup = abortable two-phase barrier
The pre-run hook fires only on the **success** path; JSC-creation failures and top-level exceptions
return from `eval` *before* it (`runtime.odin:264`). So:
- The **worker wrapper** (around `eval`) reports `Failed` to the supervisor if `eval` returns an error
  or throws — independent of the hook.
- A successful pre-run hook reports `Ready` and **blocks** on a shared barrier
  (`Mutex`+`Cond`+state) until the supervisor broadcasts `Released` or `Aborted`.
- The supervisor waits for all workers to be `Ready` or `Failed`, then broadcasts: all `Ready` →
  `Released` (workers enter `run()`); any `Failed` → `Aborted`.
- `Aborted` workers (and a worker whose hook never blocked) take a **direct teardown** path (the loop
  never ran — dispose context + free, no drain). This is why the barrier can't be a plain "wait before
  run": a parked-pre-`run` worker can't be released by `stop`+`wakeup` (its loop isn't running) — the
  condition broadcast is what releases it.

### 6.3 Stop = a shutdown state machine, not a boolean
A bare `!stop` run condition would exit `run()` *immediately*, before any loop-thread code closes
listeners or drains — then the deferred hard teardown resets live conns. Instead:
- `Loop` carries an **atomic shutdown state** `{ Running, Draining, Forced }`.
- The supervisor signals stop by `atomic_store(state, Draining)` **then** `wakeup(loop)`. The loop
  observes it and runs a **loop-thread control callback** (so it can safely touch listeners/`net_conns`)
  that: closes listeners (after a bounded backlog drain, §6.4), arms the drain timeout, and leaves the
  loop *running*.
- `run()` exits only in `Forced`. The control path transitions `Draining → Forced` when `net_conns`
  empties **or** the drain timeout fires; only then does the deferred `net_shutdown_active`
  (`net.odin:1039-1073`, the *hard* teardown) reset whatever remains. (`net_shutdown_active` is the
  fallback, never the drain.)
- Per-worker DNS jobs drain because the per-loop pool (§4) joins at the worker's own teardown.

### 6.4 Bounded backlog drain
On entering `Draining`, mark the worker draining **first**, then `accept` the listener backlog under a
**budget** (count + time, part of the overall shutdown deadline) — *not* unbounded `accept until
EAGAIN`, which under sustained arrivals never returns and each accept runs a JS handler. After the
budget, **close the listener regardless**.

### 6.5 Supervisor wait-any (signals + worker exits in one wait)
A supervisor blocked in `sigwait` can't notice an abnormal worker exit, and sequential `thread.join`
blocks on a healthy worker while another has failed. So the supervisor `poll`s **`signalfd` + a
worker-exit `eventfd`** together: every worker publishes its terminal status (atomic) and writes the
exit fd **before** exiting. A `SIGINT`/`SIGTERM` or any worker exit wakes the supervisor, which drives
the stop state machine across all workers. `SIGINT`/`SIGTERM` are blocked in workers via
`pthread_sigmask` (inherited from the supervisor blocking them before spawn) so delivery is
deterministic and the supervisor's `signalfd` owns them.

### 6.6 Crash policy
One worker exiting abnormally → supervisor stops the rest + exits non-zero (a crash is usually a
deterministic app bug all workers share; auto-restart is out of scope).

---

## 7. Opt-in API — worker count (validated)

- **`LAVA_WORKERS`**: unset/`1` → today's single-loop path (no threads); `auto` →
  `os.get_processor_core_count()`; an explicit integer → that many.
- **Validation (fail-fast, not silent):** reject `0`, negative, malformed, and out-of-range values
  with a clear startup error; enforce a documented upper bound (e.g. 256) so a typo/overflow can't
  spawn thousands of workers; `LAVA_WORKERS>1` on darwin/windows is a hard error (§1).
- Alternatives noted: `--workers` flag (env is container-friendlier); a Bun-style lazy `reusePort`
  option (more magical) — deferred. A JS `cluster` module is out of scope.

---

## 8. Slice 3b (zerocopy) — deferred, summarized for context

Separate fast-follow PR with its own design. Must build a first-class two-CQE op primitive: a
`submit_send_zc` whose slot survives until `IORING_CQE_F_NOTIF` (not the result CQE), an
`Op_Completion` variant distinguishing result-vs-notif, `active_io_count` counted until the NOTIF,
drain dispatch classifying `F_NOTIF` (distinct from the multishot-RECV `F_MORE` path that also keys off
`cqe.flags`), a per-op owned send buffer (not the rotated `active_send` pair), a size threshold
(~16 KiB), and a capability fallback. None of this is in 3a.

---

## 9. Open questions for review
1. **`listen(0)` coordinator**: ship the reject-under-multi-worker contract for 3a (recommended) vs
   build the listener-coordinator (ordinal+address keyed, timeout, mismatch detection) now?
2. **Opt-in**: `LAVA_WORKERS` env (recommended) vs `--workers` flag?
3. **HOL/skew**: accept the `REUSEPORT` backlog tradeoff for v1 (recommended) vs BPF steering now?
4. **Drain timeout / backlog budget** default values?
5. Resolved (recording): DNS → per-loop generic pool (§4); crash → fail-fast (§6.6); `auto` →
   `get_processor_core_count` (§7); `process.exit` → whole-process (§3.4); output → one locked writer
   (§3.3); unsupported platform / invalid count → hard error (§1, §7).

---

## 10. Test & verification plan

**Deterministic failure-interleaving (not just stress)** — stress alone won't expose barrier /
stop-wakeup / init races, so add fault injection at each stage:
- **Startup barrier**: inject failure at each worker stage (JSC create, top-level throw, bind,
  `SO_REUSEPORT` set) → assert clean abort + full teardown, no leaked threads/fds/contexts; a worker
  that exits *before* the barrier release; simultaneous signal + worker failure.
- **Stop/drain**: signal during sustained arrivals → assert the bounded backlog budget + drain timeout
  hold (shutdown is bounded), in-flight conns either finish or are reset only after the deadline; the
  state machine reaches `Forced` exactly once.
- **`SO_REUSEPORT`**: `setsockopt` failure surfaces errno + aborts; staggered `listen`; multiple
  servers; `listen(0)` under multi-worker errors cleanly.
- **Globals**: N workers starting simultaneously (perf clock, fetch classes, TLS ctx) → single init;
  concurrent logging across all output paths (console, uncaught, internal) → every line intact.
- **Integration**: throughput **scales** with workers (headline); `server.address().port` identical
  across workers; **skewed-load** (HOL); `process.exit()` from one worker; both proactor & readiness.
- **Platform**: darwin/windows **runtime** tests that `LAVA_WORKERS>1` errors and `=1`/unset runs
  (not compile-only); run **tsan**-instrumented tests where supported.
- **Crash guard**: existing GC-stress guard, per-worker / multi-worker.

## 11. Commit staging (one 3a PR)
1. §3 process-global fixes (`Once`; one locked writer; `process.exit` doc) — single-worker unchanged.
2. Fetch DNS → `eventloop.pool_submit` + cancellable jobs; retire `fetch_dns_pool`.
3. Supervisor + worker spawn + abortable two-phase barrier + `LAVA_WORKERS` validation; `N==1` inline.
4. Shutdown state machine + pre-run hook + `signalfd`+exit-fd wait-any + bounded drain.
5. `SO_REUSEPORT` (checked) + `listen(0)` reject + startup-bind-aborts.
6. Tests (fault injection + tsan + platform) + docs.
