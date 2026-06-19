# Lava Architecture

> An architectural overview and forward-looking review of the Lava runtime.
> Companion to `README.md` (how to build/run) and `ROADMAP.md` (feature status).
> This document explains *how the pieces fit together*, *why the boundaries are
> where they are*, and *where the architecture should go next* to become the most
> elegant, fast, and predictable JavaScript runtime we can build.

---

## 1. What Lava is

Lava is a Node-compatible JavaScript runtime built on **JavaScriptCore (JSC)** as
the execution engine and **Odin** as the systems language for everything around
it: the engine FFI, the event loop, the I/O transports, and the native half of
the standard library. Compatibility targets modern Node (22+/24 behavior) rather
than legacy APIs.

Two design decisions shape the whole system:

1. **JSC is the VM; Odin owns the runtime.** Lava does not embed V8 or write its
   own interpreter. It drives JSC through its C API and builds the *runtime* — the
   event loop, module system, timers, I/O, process model — natively in Odin.
2. **The standard library is layered: native primitives + embedded JS.** Hot or
   unsafe operations (byte codecs, hashing, sockets, the loop) live in Odin; the
   ergonomic, spec-shaped surface (`Buffer`, `fetch`, Web Streams, `URL`,
   `console`) is JavaScript embedded into the binary at compile time and wired up
   by a small loader. See §3.3.

---

## 2. System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  cmd/lava (CLI)                          main.odin                     │
│  parses argv → builds an eventloop.Loop → calls runtime.eval/run_file  │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │
┌───────────────────────────────▼──────────────────────────────────────┐
│  pkg/runtime  (orchestration)                                          │
│                                                                        │
│   runtime.odin      eval(): JSC context lifecycle, ownership, drains   │
│   globals.odin      global surface, Runtime_State, JS↔loop callbacks   │
│   require.odin      CommonJS loader (cache, .js/.cjs/.mjs/.json)        │
│   module_resolution native resolver (file/dir/node_modules/main)       │
│   fs / buffer / crypto / dns / sqlite / fetch*  native primitives      │
│                                                                        │
│   js/internal/*.js  embedded spec surface (Buffer, fetch, streams, …)  │
│   js/console.js     console implemented in JS over two write prims     │
└───────────────┬───────────────────────────────────┬──────────────────┘
                │                                     │
┌───────────────▼─────────────┐      ┌────────────────▼─────────────────┐
│  pkg/jsc  (engine FFI)       │      │  pkg/runtime/eventloop            │
│   bindings_{linux,darwin,    │      │   loop.odin   phases, timers,     │
│     windows}.odin            │      │     microtasks, async handoff     │
│   jsc_init* (Windows bring-  │      │   loop_{linux,darwin,windows}     │
│     up + locked typed-array) │      │     io_uring/epoll · kqueue · IOCP│
└──────────────────────────────┘      └───────────────────────────────────┘
```

Supporting packages `pkg/bundler` and `pkg/install` are placeholders today
(README only) — reserved for the transpile/bundle and package-manager stories.

---

## 3. Component architecture

### 3.1 The event loop (`pkg/runtime/eventloop`)

The strongest part of the system, and the right thing to have gotten right first.

- **Node-faithful phases.** `run_once` (`loop.odin:619`) runs the canonical order:
  next-tick → microtasks → timers → poll (I/O completions, then block) → check
  (`setImmediate`) → close. Each phase uses a *sequence limit* so callbacks queued
  *during* a phase defer to the next iteration — this is what makes ordering
  deterministic and matchable against Node.
- **Timers are a binary min-heap** keyed on `(due_ms, seq)` (`timer_heap_*`), so
  ties fire in FIFO order (Node parity) and push/pop are O(log n). Cancelled
  timers are dropped lazily at the root rather than compacted every tick.
- **Two clocks.** `real_time` mode tracks the monotonic wall clock; the default
  (used by tests) advances a *logical* clock explicitly. This dual-clock design is
  quietly powerful — it is the seed of a future deterministic record/replay mode
  (§6).
- **Cross-thread completion handoff** mirrors libuv's `uv_async`:
  `async_begin`/`post_async`/`drain_async` (`loop.odin:248-302`) let an off-loop
  worker enqueue a completion under a mutex and wake the loop, which drains it on
  its own thread. `active_async` keeps the loop alive and blocked in `poll` until
  the worker finishes. **This primitive already exists but is under-used** — it is
  the foundation the thread pool in §5.2 should build on.
- **Lifecycle accounting is meticulous.** `watched`/`active_io_count`,
  `reffed_timer_count`, and the `dispose` hook contract (`loop.odin:8-14`) ensure a
  handle's GC-protected binding is released exactly once — on fire or on
  cancellation, never both, never neither.

### 3.2 Engine FFI (`pkg/jsc`)

Thin, per-platform `foreign` declarations of JSC's C API. Highlights:

- The global object is created from a custom `LavaGlobal` JSClass whose private
  slot stores `Runtime_State` (`globals.odin:154`), so the loop pointer and module
  cache are **unreachable from user JavaScript** — no writable `__loop_ptr__`.
- `jsc_init.odin` carries a Windows-only bring-up shim (`JSC::initialize` +
  disabling a broken baseline-JIT tier in the bun-webkit build) and a
  `make_uint8_nocopy_locked` helper that enters the VM lock when creating typed
  arrays from outside a JSC callback (e.g. the fetch streaming body driven from the
  loop). Both are no-ops on Linux/macOS — a clean conditional-compilation pattern.

### 3.3 Standard library: native + embedded JS

Built-ins are JS factories `#load`-embedded at compile time (`globals.odin:1144`)
and instantiated by `loader.js`. Each factory receives `(require, module, exports,
native)`; the native fourth argument carries Odin-backed bindings (crypto, buffer,
fetch, sqlite, dns) so **nothing transient lands on `globalThis`**
(`install_internal_modules`, `globals.odin:878`). This is an elegant boundary:
the spec surface is readable JS, the sharp edges are native, and the seam is one
well-defined argument.

The JS layer is substantial and high quality: `url.js` (2071 LOC, WHATWG URL),
`streams.js` (2027, Web Streams), `buffer.js` (1646), `fetch.js` (1054),
`crypto.js` (917). Errors use Node-shaped coded errors (`ERR_INVALID_ARG_TYPE`,
`ERR_OUT_OF_RANGE`, …). Native byte ops are gated by a size threshold
(`NATIVE_BYTEOP_MIN`) so small inputs avoid FFI overhead — a thoughtful perf call.

### 3.4 Module system (`require.odin`, `module_resolution.odin`)

- CommonJS is the substrate. `native_require_cb` consults, in order: the module
  cache → JS internal builtins (`require_builtin`) → native `fs` → filesystem
  resolution. Circular requires terminate via a pre-registered partial-exports
  entry (`__lava_precache`), and a module that throws while loading is *removed*
  from the cache so a later require re-runs it (Node parity).
- `.mjs`/static `import`/`export` are handled by a **source transform**
  (`esm.js`) that rewrites ESM onto the CommonJS `require`, not by JSC's native
  module records (the classic C API only runs script-goal source). This is
  pragmatic and works, with documented divergences (named imports from CJS).
- Resolution (`module_resolution.odin`) covers file probes, directory `main`/
  `index`, and `node_modules` walking. **`package.json` `"exports"` conditional
  resolution is not yet implemented** — a real gap for modern packages.

### 3.5 I/O transports (`fetch_*`, `dns.odin`, `tls.odin`)

`fetch_transport.odin` is a platform-agnostic connect→[TLS]→write→read state
machine; each platform supplies only narrow socket primitives, and TLS is a
swappable backend (OpenSSL, or a rejecting stub). DNS resolves off-loop on a
bounded 4-worker pool. Streaming request *and* response bodies are real
incremental `ReadableStream`s with backpressure. This is the second-strongest
subsystem after the loop, and it validates the `post_async` design end to end.

---

## 4. Cross-cutting concerns

### 4.1 Memory model

Disciplined and consistent. A per-tick `free_all(context.temp_allocator)` at the
single choke point in `run_once` (`loop.odin:620`), mirrored per-require
(`require.odin:58`) and per-eval (`runtime.odin:106`), bounds scratch growth. JSC
values held across loop turns are explicitly `JSValueProtect`/`Unprotect`'d with
the lifecycle documented at every site. Queue buffers are bound to the loop
allocator up front (`loop.odin:157`) so a worker thread's `post_async` cannot
accidentally adopt the wrong allocator.

One allocator hazard is the `proc "c"` boundary: a JSC callback resets `context` to
`runtime.default_context()` (the heap allocator), so a long-lived string cloned
*inside* a callback but freed from a teardown proc running under the caller's context
mismatches if the caller uses a custom allocator (an embedder, or the test runner's
tracking allocator). `module_cache` keys are fixed by cloning/freeing them through an
explicit `Runtime_State.allocator`. **Known, tracked (not yet fixed): the same pattern
remains in `fetch` (`Fetch_Request` method/url/host/path), `dns`
(`Dns_Lookup_Request.hostname`), and the fetch DNS pool (`DNS_Job.host`).** These free
under *multiple* contexts (e.g. `fetch_reclaim_pending` during normal operation vs
`fetch_destroy_pending` at teardown), so the robust fix is *localized* — store the
owning allocator on each request/job and clone+free through it (as `module_cache`
does), rather than context-based. Benign in the shipped CLI (one heap allocator
everywhere); a follow-up closes it for custom-allocator embedders.

### 4.2 Concurrency model

**Single VM, single JS thread, single context.** Off-loop work is limited to the
DNS pool today. There are no `worker_threads`, no isolates, and no general thread
pool — so blocking work (synchronous `fs` reads, `crypto` KDFs) runs on the loop
thread. This is the central scalability ceiling (§5.2).

### 4.3 The FFI trust boundary — resolved (#159)

The code once carried a *distrust of the FFI boundary*: several sites avoided the
`JSValueIs*` / `JSValueToBoolean` predicates in favor of `JSValueGetType`, with
comments calling them "unreliable across the FFI" (the sqlite readBigInts / bind
"heisenbugs" — *a JS `false` came back `true`*).

**Root cause, now pinned down:** the predicates were historically declared
`-> b32` (a 4-byte boolean). JSC's C API returns C `_Bool` (1 byte); on SysV-AMD64
and AArch64 the value sits in the low byte of the return register and the upper
bytes are *undefined*. Reading 4 bytes picked up that garbage, so a `false` (low
byte 0, upper bytes nonzero) read back truthy. The bindings already declare these
`-> bool` (Odin `bool` is 1 byte, reads only the low byte) — the ABI-correct fix —
and the codebase already trusts `JSValueToBoolean` in dns/fetch/fs/buffer; only one
stale workaround (sqlite `readBigInts`) and a few misleading comments remained.

`cmd/lava/jsc_predicates_test.odin` now pins the full predicate matrix down,
including from inside a `proc "c"` callback (the context the comments blamed), so a
regression to a wide return type fails loudly. The stale workaround and comments
are gone. This closes the consistency issue.

### 4.4 Error handling

`pkg/runtime/errors.odin` is the single source of truth for native error
construction. `make_native_error(ctx, ctor_name, message, code)` builds a **real**
instance of the named JS error constructor (so `err instanceof TypeError` holds, as
in Node — not just `err.name`), attaches Node's `err.code`, and falls back to a
base Error with an overridden name only when the constructor is unreachable.
`make_js_error` / `make_js_named_error` and the typed `ERR_*` helpers
(`err_out_of_range`, `err_invalid_arg_type`, …) all route through it; the ad-hoc
"base Error + manual `name`/`code` patch" sites (process.exit, sqlite, module
resolution) were migrated. The JS layer still sets `err.code` per module; growing
the `ERR_*` helper list lets native sites adopt the same codes as they need them.

---

## 5. Findings & prioritized recommendations

Severity: **P0** trust/correctness foundations · **P1** scalability/perf · **P2**
documentation/process.

### 5.1 [P0] Close the FFI trust boundary ✓ + unify the error layer ✓

**FFI boundary — done (#159).** The "`JSValueIs*` is unreliable" workaround was
root-caused to the retired `-> b32` (4-byte) return reading undefined upper bytes
of a 1-byte C `_Bool` (§4.3). The bindings already return the ABI-correct `-> bool`;
`cmd/lava/jsc_predicates_test.odin` now proves the predicate matrix from both a
normal context and a `proc "c"` callback, the last stale workaround (sqlite
`readBigInts`) uses `JSValueToBoolean` again, and the misleading comments are
corrected. The remaining `JSValueGetType` uses are idiomatic multi-way type
switches, not hazard workarounds.

**Error layer — done.** `pkg/runtime/errors.odin` is now the single source of
truth (§4.4): `make_native_error` builds real error instances (so `instanceof`
matches Node) carrying `err.code`, with typed `ERR_*` helpers mirroring Node's
message templates. `make_js_error` / `make_js_named_error` route through it and the
ad-hoc code-setting sites were migrated; `cmd/lava/errors_test.odin` pins the shape
(instanceof + name + message + code). The `ERR_*` helper set grows as native call
sites adopt coded errors — the mechanism and parity contract are in place.

### 5.2 [P1] A real thread pool → non-blocking `fs` and `crypto`

**Problem.** Synchronous file reads and CPU-bound KDFs run on the loop thread, so a
single large `fs.readFile` or `pbkdf2` stalls all timers and I/O. The ROADMAP
itself notes `fs.readFile`'s "read is synchronous for now."

**The good news: the hard part is already built.** `async_begin` / `post_async` /
`drain_async` is exactly libuv's completion-handoff contract, already proven by the
DNS pool and the fetch transport. What's missing is a *generic* worker pool that
sits on top of it.

**Step 1 — the generic pool — done (`pkg/runtime/eventloop/threadpool.odin`).**
A fixed pool (`THREADPOOL_SIZE`, libuv's default of 4) of OS threads blocking on a
shared FIFO queue, lazily started on first submit and joined at `destroy()`.
`pool_submit(loop, work, done, user_data)` does `async_begin(loop)` (keeping the
loop alive and parked in poll), runs `work` off-loop on a worker, then hands the
completion back through `post_async`, where `done` runs on the loop thread. The
invariant that **workers touch only their user_data — never the loop or JSC** keeps
the single-VM model intact; only the loop-thread `done` materializes JS values. It
generalizes the DNS pool and shares its teardown discipline (workers joined before
the async queue is torn down). Covered by deterministic tests in
`eventloop_test.odin` (off-loop work → on-loop completion; submit-then-destroy joins
in-flight work without leak/hang).

**Remaining.**
- **Step 2 — `fs.readFile`/`writeFile`** onto the pool. Subtlety: today the callback
  is delivered in the **poll phase** (`queue_io_callback`) to preserve Node's
  I/O-before-`setImmediate` ordering, whereas `post_async` completions drain at the
  *top* of the tick. So the fs completion must bridge: the pool's loop-thread `done`
  re-queues via `queue_io_callback` to keep the ordering. Pending fs requests also
  need teardown tracking (release the GC-protected callback if the loop dies
  mid-flight), as fetch does.
- **Step 3 — `crypto.pbkdf2`/`scrypt`** async forms (CPU-bound; ordering is simpler).

Synchronous `*Sync` APIs stay on the loop thread (Node does the same). This primitive
unblocks async `fs.stat`/`readdir`/`mkdir`, `fs.promises`, and any future blocking op
— making "predictable latency under load" a real property rather than an aspiration.

### 5.3 [P1] Make "fast" provable: a benchmark harness with CI gating

The README promises speed; nothing measures it. Add `bench/` with micro
(startup, `require`, JSON, Buffer codecs) and macro (fetch throughput, fs
throughput) benchmarks, recorded against Node as the same oracle the tests use.
Gate CI on regressions beyond a threshold. Without this, every perf claim and
every "is this change faster?" question is unfalsifiable.

### 5.4 [P1] Server-side networking (`node:net`, `node:http`)

Lava can make HTTP requests but cannot accept them. `node:net` (TCP server/socket)
and a `node:http` server unlock a whole class of applications and reuse the
existing transport/loop machinery. This is the highest-leverage *capability* gap.

### 5.5 [P2] Consolidate primordials in the JS layer — foundation laid

`pkg/runtime/js/internal/primordials.js` is the shared hardened baseline: a frozen
table of pristine intrinsics (captured statics + *uncurried* prototype methods via
the classic `bind.bind(call)`), so `ArrayPrototypePush(arr, x)` is a
pollution-proof `arr.push(x)`. The loader **eager-loads it first**, before any
other internal module and before user code, so the captured references are
pristine; modules consume it via `require('primordials')` and get the cached table.
This is the JS-layer analog of the native error-intrinsic capture (§4.3/§5.1).

`events.js` (EventEmitter) is the first fully migrated consumer — its internal
`Array`/`Object`/`Reflect`/`Promise` use routes through primordials, and listener
arrays are copied/spliced via species-free helpers (`arrayClone`/`spliceOne`, array
literal + index only) so a poisoned `Array[Symbol.species]` cannot reach `emit()`
either. `cmd/lava/primordials_test.odin` (a Lava-only Odin test — Node's own
EventEmitter is *not* immune here, so this can't be a Node oracle) proves it stays
correct while `Array.prototype.{push,unshift,slice,splice,map}`, `Object.create`,
and `Array[Symbol.species]` are all overwritten. Remaining modules adopt primordials
incrementally — the same grow-as-you-go model as the `ERR_*` taxonomy.

`primordials` is internal-only: the loader serves it to internal factories but
hides it from the public resolver native `require()` consults, so it neither
shadows a user package named `primordials` nor answers `require('node:primordials')`
(which Node rejects). Gating the other internal helper modules the same way is a
future follow-up.

### 5.6 [P2] Documentation & process gaps

- **No `package.json` `"exports"`** resolution — note it explicitly and plan it.
- **Event-loop backend tradeoffs undocumented** — add a short
  `pkg/runtime/eventloop/PLATFORMS.md` (io_uring vs epoll vs kqueue vs IOCP, and the
  fallback logic).
- **Odin unit tests are orphaned** in `pkg/` rather than discoverable from a test
  index — document their locations.
- **Windows provisioning is duplicated** between `ci.yml` and
  `bootstrap-windows-deps.sh`; the pinned `WEBKIT_TAG` should have a single source
  of truth.
- **`known-lava-gaps.txt`** has no structured format or CI enforcement — define
  `file:reason` tuples and check them so a regression cannot silently widen a gap.
- **`process.env` is a one-shot snapshot** (`globals.odin:1122`), not live — revisit
  with a Proxy-backed object when child processes land.
- **Stack-trace line numbers** are off by one (known) — fix once the loader wrapper
  no longer shifts line 1.

---

## 6. The longer view: what would make Lava *best in class*

Three differentiators, each a natural extension of architecture that already
exists rather than a bolt-on:

1. **TypeScript/JSX-first.** Native transpile-on-load (the empty `pkg/bundler`
   becomes a real transform stage) removes the build step that Node still imposes.
   This is the largest single "why Lava over Node" lever.
2. **Deterministic by construction.** The loop's existing dual clock (real vs
   logical) is half of a record/replay engine. Capture every nondeterministic input
   — timer firings, I/O completions, `Math.random`, `Date.now` — and replay them
   byte-for-byte. A runtime where any run can be deterministically reproduced for
   debugging would be genuinely novel, and the oracle test methodology already
   thinks this way.
3. **Capability-based security in the loader.** A permissions model finer than
   Deno's, enforced at the module/native-binding boundary that Lava already funnels
   everything through.

Then the table-stakes parallelism story: `worker_threads` (multiple JSC contexts,
one per thread, message-passed), built on the same thread-pool and `post_async`
foundations as §5.2.

---

## 7. Recommended sequence

| # | Work | Class | Rationale |
|---|------|-------|-----------|
| 1 | ~~FFI root-cause (#159) + unified `ERR_*` error layer~~ ✓ | P0 | FFI boundary proven (§4.3); `errors.odin` factory in place (§4.4) — foundation of parity tests |
| 2 | Generic thread pool → async `fs`/`crypto` | P1 | Removes the loop-blocking ceiling; reuses the proven `post_async` primitive |
| 3 | Benchmark harness + CI perf gate | P1 | Makes "fast" provable instead of asserted |
| 4 | `node:net` + `node:http` server | P1 | Unlocks server-side applications |
| 5 | `package.json` `"exports"`; consolidate primordials | P2 | Modern-package compat; uniform pollution safety |
| 6 | TypeScript/JSX transpile-on-load | Vision | Biggest differentiator vs Node |
| 7 | `worker_threads`; deterministic record/replay | Vision | Parallelism + a genuinely unique capability |

---

## 8. Verdict

Lava is, today, a **carefully engineered early-stage runtime** whose core — the
event loop, the FFI lifetime discipline, the native/JS layering, and the
oracle-based test methodology — already meets a high bar. The work ahead is not
rescue work; it is *extension and hardening*: pin down the one boundary the code
distrusts, lift blocking work off the loop thread, prove the performance, and then
reach for the differentiators (TS-first, determinism, capabilities) that the
existing architecture is unusually well-positioned to deliver.
