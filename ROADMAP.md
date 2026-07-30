# Lava roadmap

Status of the Node.js port. Baseline target: Node 24 on JavaScriptCore, with a
native event loop (kqueue / io_uring+epoll / IOCP).

## Done

The original runtime plan (PR #1) is complete:

- [x] **GC-protect bindings** — `JSValueProtect`/`JSValueUnprotect` so JS timer
      callbacks survive across loop turns (`pkg/jsc/bindings_*.odin`).
- [x] **Node global surface** — `console`, `process`
      (`argv`/`env`/`platform`/`version`/`pid`/`nextTick`/`exit`/`cwd`),
      `setTimeout`/`setInterval`/`setImmediate` + `clear*`, `queueMicrotask`,
      `globalThis` (`pkg/runtime/globals.odin`).
- [x] **Full `console` surface** — `log`/`info`/`debug`/`error`/`warn`,
      `dir`/`trace`/`assert`, `count`/`countReset`,
      `group`/`groupCollapsed`/`groupEnd`, `time`/`timeEnd`/`timeLog`,
      `table`, `clear`, `Console`, plus `util.format` (`%s/%d/%i/%f/%j/%o/%O/%c`)
      substitution and value inspection. Backed by two native write primitives;
      the rest is a JS prelude (`CONSOLE_PRELUDE` in `pkg/runtime/globals.odin`),
      matching Node's console output on the compat cases.
- [x] **CLI drives the loop** — `lava run`/`eval` create an `eventloop.Loop` and
      run it to idle (`cmd/lava/main.odin`).
- [x] **Loop pointer is private** — stored in the global object's private data
      (`LavaGlobal` JSClass), not a writable `__loop_ptr__` JS global.
- [x] **Module cache** — modules run once; `require` throws `MODULE_NOT_FOUND`
      instead of returning `undefined`.
- [x] **`fs.readFileSync`** returns a `Uint8Array` (no encoding) or string (with
      encoding); no more lossy UTF-8 on binary data.
- [x] **`fs.readFile`** (async callback form) — `(path[, options], cb)`, delivered
      on the event loop's poll phase via a new `queue_io_callback`, so the callback
      runs before a same-turn `setImmediate` (matches Node; passes the
      `08-io-before-immediate` oracle). The read itself is synchronous for now —
      not yet threadpool-backed — but the callback timing matches.
- [x] **Memory** — `free_all` the temp arena at the require boundary;
      single-allocation JS→string conversion.
- [x] **Windows support** — `pkg/jsc/bindings_windows.odin`
      (`system:JavaScriptCore.lib`), OS-aware path helpers; `select`-based
      event-loop backend.
- [x] **CI** — `.github/workflows/ci.yml`: full check/build/test on Linux
      (`javascriptcoregtk-6.0`) and macOS; on Windows, type-check + codegen, the
      event-loop tests, and a real JavaScriptCore-linked `lava.exe` runtime smoke
      (JSC provisioned from the Bun WebKit fork).

## Remaining

Tracked against the `tests/node-compat/cases` oracle. Every case in
`tests/node-compat/cases` now passes under Lava, including the ESM cases
(`01-esm`, `12-esm-features`); the ESM loader below has landed.

### Internal JS module layer (done in this batch)

Built-ins now live as embedded JS factories under `pkg/runtime/js/internal/`,
wired by a small loader (`loader.js`) that native `require()` consults before
the filesystem (`require_builtin` in `globals.odin`). Minimal, original
implementations — a small internal `primordials` table for pollution hardening
(§5.5 of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)), no `internalBinding`
coupling.

- [x] **internal module loader** — lazy, cached, `node:`-prefix aware, eager for
      modules that install globals (Buffer, fetch).
- [x] **`util`** — `inspect` / `format` / `formatWithOptions`.
- [x] **`events` (EventEmitter)** + static `once` — _(passes `06-events`)_
- [x] **`node:assert`** real strict assertions (`AssertionError`, deep compare)
      — replaced the dangerous no-op.
- [x] **`Buffer` global** — `from`/`alloc`/`concat`/`copy`/`toString` over
      `Uint8Array`; utf8/hex/base64 codecs backed by Odin (`pkg/runtime/buffer.odin`,
      `core:encoding`) as the sole impl — _(passes `03-buffer`)_
- [x] **`node:crypto`** — `createHash`/`createHmac` (md5/sha1/sha2/sha3/blake2/sm3),
      `randomBytes`/`randomUUID`/`randomFill*`, `pbkdf2`/`pbkdf2Sync`, all backed
      by Odin `core:crypto` (`pkg/runtime/crypto.odin`) — _(passes `07-crypto`)_
- [x] **`fetch` / `Response` / `Headers` / `Request`** globals — body + headers
      machinery is real; the `http://` network transport is now Odin-backed
      (`pkg/runtime/fetch.odin`, `fetch_linux.odin`): non-blocking
      connect/write/read on the event-loop `IO_Watcher`, HTTP/1.1 request
      serialization, and response parsing (Content-Length + chunked). The promise
      is created in JS (`new Promise` + native success/error callbacks), so no
      `JSObjectMakeDeferredPromise` binding is needed. _(passes `08-fetch`;
      end-to-end node-parity via `make test-fetch-smoke`)_

### High priority (the Odin / native part)

- [x] **The primordials ratchet cannot see accessor reads, and reports 0
      anyway** — fixed: it parses with acorn and counts four classes, each
      baselined separately — `method`, `invoke` (`.call`/`.apply`), `accessor`
      (reads through a configurable prototype getter) and `global` (a
      replaceable global read live instead of captured). Verified against the
      defect that motivated it: at `07676d8^` — the commit inside #320 that
      actually carried the vector — `encoding.js` scores 10 accessor sites
      including `units.buffer` at line 360, against a then-recorded baseline of
      0, so the tool exits 1 and names the line a reviewer had to find by eye.
      (An earlier version of this entry cited `401ea40`; that revision predates
      the vector and scores 8 accessor sites on the neighbouring `bytes.buffer`
      read.) The detector self-tests on every run against known-positive and
      known-negative fixtures with exact per-class counts, and refuses to report
      on the tree _or to rebaseline_ if one regresses — a blind control is worse
      than none. `--update` also refuses to raise a floor without
      `--allow-raise`.
      Do not copy the tree totals into prose; `pollution-baseline.json` is the
      source and `make check-primordials` prints the live number. Scope is now
      all of `pkg/runtime/js`, not just `internal/` — the real 371-line
      `console.js` was outside the scan while the baseline described the 7-line
      re-export, so the report read as "console is hardened".
      One class remains on the author (an object literal indexed by a
      caller-supplied key needs `__proto__: null`), and two are uncounted by
      construction because they read a well-known symbol rather than a named
      property: the iterator protocol, and a poisoned `Object.prototype.then`
      reached by an internal `await`. That last one is a plain data property
      settable by an ordinary merge gadget — the sharpest uncounted vector, and
      its own item below.
- [ ] **`Object.prototype.then` is an uncounted, easily-set pollution vector** —
      a plain data property, so an ordinary merge/`obj[a][b]=c` gadget sets it,
      no `defineProperty` needed. Verified under `bin/lava`: `await { plain: 1 }`
      and `Promise.resolve(obj)` both execute attacker code inside an internal
      await, and internals carry 5 awaits plus 34 `.then(` sites. The ratchet
      cannot count it (awaiting reads a well-known symbol, not a named
      property), so this needs a code convention instead: never `await` a
      caller-supplied value directly, or route it through a captured
      `PromiseResolve`. Same shape for the iterator protocol (`for…of`, spread)
      on caller-supplied values.
- [x] **Promise ↔ event-loop ordering.** JSC drains its own promise microtask
      queue at every C-API boundary, so `Promise.then` used to run _before_
      `process.nextTick` (Node is the reverse). `queueMicrotask` lives in a JS shim
      (`js/internal/microtasks.js`) that schedules a JSC microtask, so it shares one
      FIFO with promise jobs. `process.nextTick` keeps Node's **absolute** priority
      by _not_ living in JSC's queue: nextTick callbacks accumulate in a JS-owned
      queue, and native drains it at two checkpoints that recreate Node's
      `do { drain nextTicks; run microtasks } while (nextTicks)` loop on top of
      JSC's auto-drain — checkpoint 1 (`dispatch`) runs every event-loop callback
      and drains nextTicks before returning across the C boundary (so a nextTick
      beats a promise job queued earlier in the same turn); checkpoint 2 re-drains
      after JSC auto-drains the promise jobs (so a nextTick queued _first inside a
      microtask_ still runs after the microtask queue empties). The top-level turn
      gets checkpoint 1 via a drain appended to the entry source. Passes the full
      `01`/`09`/`10` set, including absolute priority — fully portable, no
      `JSC::VM::DrainMicrotaskDelayScope`. See issue #16 and
      `globals.odin:invoke_user_callback`. _(`fetch`/`fs` completions route through
      the same dispatch path so callbacks they run get the same ordering.)_
- [x] **ESM** — `.mjs` files, static `import` / `export`, `import.meta.url`, and
      `node:url` `fileURLToPath` now work. JSC's classic C API
      (`JSEvaluateScript`) only runs script-goal source, so an ESM→CommonJS
      source transform (`js/internal/esm.js`, stored on `Runtime_State` and
      applied by `native_require_cb` / the `.mjs` entrypoint) rewrites the static
      module syntax onto the existing native `require`, tagging the namespace with
      a non-enumerable `__esModule` for CJS↔ESM default interop. Handles only
      static, statement-position forms — anything else errors explicitly rather
      than mistranslating. _(passes `01-esm`, `12-esm-features`.)_ _Divergence:_
      named imports from a CJS module are resolved by runtime destructuring, so
      Lava accepts some that Node's static cjs-lexer rejects.
- [x] **Native CSPRNG** — `crypto.randomBytes`/`randomUUID`/`randomFill*` now
      draw from the OS CSPRNG via `crypto.rand_bytes`, replacing `Math.random`.
- [x] **Real network transport for `fetch()`** — `http://` and `https://` over
      non-blocking sockets on the event loop. The connect→[TLS]→write→read state
      machine is shared (`pkg/runtime/fetch_transport.odin`); each platform
      supplies narrow socket primitives plus a swappable TLS backend. Implemented for
      **Linux** (io_uring/epoll, `core:sys/linux`), **macOS** (kqueue,
      `core:sys/posix`), and **Windows** (`select`, Winsock). TLS uses OpenSSL on
      Linux/Windows (`pkg/runtime/tls.odin`); on Windows the machine certificate store
      is loaded into OpenSSL's trust store; on **macOS** it uses Apple's
      Security.framework / SecureTransport natively (`pkg/runtime/tls_darwin.odin`,
      #143), verifying against the system keychain with no OpenSSL dependency. DNS resolves
      off the loop on a **bounded resolver pool** (4 workers, lazily created;
      `pkg/runtime/fetch_dns_pool.odin`), which resolves both families and returns an
      ordered IPv4-then-IPv6 list (#77, #145) — replacing the former one-thread-per-
      lookup. All three platforms build and run for real in CI — the Windows job links
      a JavaScriptCore-backed `lava.exe` and runs it. HTTP correctness landed too —
      redirect following, `Set-Cookie`/`getSetCookie()`, URL/port validation, response
      head + chunk-size caps, EINTR retries (#99) — and the connect path now falls back
      across the resolved-address list (#145).
      Follow-ups: Happy Eyeballs — staggered/raced IPv4/IPv6 connects — and multiple
      A/AAAA records beyond the first per family (remaining part of #145).
- [x] **Streaming fetch bodies (#31)** — `response.body` is a real, incrementally
      fed `ReadableStream` (`getReader().read()`, async iteration, `cancel()`,
      `tee()`, `locked`). The transport delivers status + headers as soon as they
      parse, then pushes decoded body chunks (incremental chunked de-framing and
      Content-Length / read-until-EOF identity framing) until the body completes or
      errors — no full-body buffer is kept. The buffered accessors (`text()`,
      `json()`, `arrayBuffer()`, `bytes()`) drain the same stream, so streaming and
      buffering share one consumption path and a body is consumed at most once.
      Backpressure pauses the socket read when the consumer saturates the
      high-water mark and resumes on drain; an abandoned body no longer pins the
      loop (Node parity). Cross-platform via the shared transport
      (`pkg/runtime/fetch_transport.odin`). Verified by `make test-fetch-smoke`.
      Lifetime note: the io_uring backend truly cancels a watcher's `POLL_ADD` on
      `unwatch_fd` (`IORING_OP_ASYNC_CANCEL`) and keys every poll by a generation
      token, so a straggling completion after a paused/resumed read or an abort is
      dropped without touching freed memory (#183); the pointer-based backends
      (epoll/kqueue/select) still reclaim a settled request two loop iterations
      later, to outlast a readiness event already copied into an in-flight poll batch.
- [x] **Streaming fetch request bodies (#182)** — a `ReadableStream` / async-iterable
      request body now streams **incrementally as `Transfer-Encoding: chunked`** rather
      than being buffered to bytes first: the head is written, then chunks are pulled
      one at a time from the JS producer (a `pushBody`/`endBody` ⇄ `onBodyDrain`
      channel mirroring the response pull path), framed, and written to the socket —
      no full-body buffer is kept on either side. Socket write backpressure pauses the
      producer (the next pull is deferred until the current frame drains, mirroring the
      response read resume); a producer error or an abort signal tears the in-flight
      upload down. Cross-platform (plaintext + TLS) via the shared transport. A `Blob`
      (known length) and string/Buffer/typed-array bodies keep the buffered
      Content-Length fast path. Limitations: half-duplex only (the whole request body
      is sent before the response is read, matching `duplex: 'half'`); an
      immediately-empty producer is sent as an empty chunked body (terminator only)
      rather than Node's `Content-Length: 0`; a server that rejects chunked request
      bodies (or closes mid-upload) surfaces as a failed request. Verified by
      `make test-fetch-smoke`.
- [x] **Event-loop I/O driving** — fetch was the first real `watch_fd` consumer
      and exposed several gaps, now fixed (`pkg/runtime/eventloop/`): - io_uring `POLL_ADD` mask is written to `poll_events` (was `addr`, so no
      fd poll ever fired) and SQEs are submitted at arm time (not only at the
      next `poll`, which a due timer could skip indefinitely). - `run_until_idle` blocks in `poll` when a socket is the only pending work,
      and advances the virtual clock on a timer-deadline wake so a timer
      co-pending with I/O is not dropped. - timer delays are floored at 1ms (Node parity), so a 0ms timer cannot
      busy-spin and starve pending I/O. Settled requests are reclaimed on the
      next request (bounded retention), not held until teardown.

### Medium priority (more of the Node surface)

- [x] **`TextEncoder` / `TextDecoder` / `structuredClone`** globals (pure JS;
      TextEncoder/TextDecoder reuse the buffer utf8 codec; structuredClone is the
      HTML clone algorithm in `js/internal/structured_clone.js`). _(cases `11`, `13`.)_
- [x] **Full `node:path`** — `resolve`, `relative`, `normalize`, `dirname`, `sep`,
      `delimiter`, `parse`, `format`, and the `posix`/`win32` namespaces, ported to
      JS (`js/internal/path.js`) so semantics match Node exactly; the partial native
      implementation was retired. _(case `02`.)_
- [x] **More `node:fs`** — `writeFileSync` (string/Uint8Array), `mkdirSync`
      (`recursive`), `statSync` (`Stats` with `size`/`*Ms` times + `isFile`/
      `isDirectory`/`isSymbolicLink`), `readdirSync`, `rmSync` (`recursive`/`force`),
      and async `writeFile`. _(case `02`.)_ Deferred: async `stat`/`readdir`/`mkdir`,
      `fs.promises`, file handles, watchers.
- [x] **Wire `pkg/std/sqlite`** — `node:sqlite` (`DatabaseSync` with
      `exec`/`prepare`/`isOpen`/`close`, `StatementSync` with `get`/`all`/`run`
      and `?` parameter binding; INTEGER/REAL/TEXT/BLOB/NULL coercion). Native
      libsqlite3 bindings in `pkg/std/sqlite`; JSC bridge + handle registry in
      `pkg/runtime/sqlite.odin`; JS surface in `js/internal/sqlite.js`. Needs the
      sqlite3 dev package (Linux: `libsqlite3-dev`; macOS: system sqlite3). Runs
      the oracle through Lava via `make test-sqlite-lava`.

### Low priority / correctness polish

- [x] **Host-native dispatch answered a miss with `undefined`** — fixed (#320):
      the registry fails closed. A miss meant our own tables were inconsistent,
      and several natives write through a caller-supplied buffer and signal
      nothing on return, so `undefined` forged success — `crypto.randomBytes`
      would have returned a zeroed `Buffer.alloc` as CSPRNG output, `fromString`
      uninitialized `allocUnsafe` pool memory. The miss now raises, `host_throw`
      reports whether it actually raised, and `crypto.js` identity-checks
      `randomFill` as a second layer.
- [x] **`platform_init` double-closed the wakeup pipe on the epoll failure
      path** — fixed: it closed both ends but left their NUMBERS in
      `wakeup_pipe`, and `destroy` calls `platform_destroy` unconditionally, so
      they were closed again. A wrong-fd close, not a leak, and the trigger is
      EMFILE — precisely when the kernel is recycling numbers, so the second
      close lands on an unrelated descriptor. darwin already reset; Linux now
      does too, pinned by `failed_platform_init_does_not_double_close`, which
      tightens `RLIMIT_NOFILE` and requires a canary on the recycled number to
      survive teardown.
- [x] **`clearInterval` leaks** the `JS_Callback` heap binding + GC protection —
      fixed: the loop's dispose hook (`js_callback_dispose` in
      `pkg/runtime/globals.odin`) frees the binding when an interval is cleared.
- [x] **`setTimeout`/`setInterval` ignore extra trailing args** — fixed:
      `capture_timer_args` clones and GC-protects the trailing arguments and
      forwards them to the callback (Node parity).
- [x] **`bench --gate` reads a single launch** — fixed: `--gate` now takes the
      MEDIAN of 3 launches per side (`collectMedian` in `bench/run.mjs`);
      report-only runs still take one, since they fail nothing and so pay no
      false-positive cost. The single-launch estimator's measured spread was
      1.11-1.28x quiet and up to 2.26x under load, so a cap sized to catch a ~1.4x
      regression could not separate the two; median-of-3 cuts the loaded-box
      false-positive rate ~40% with detection unchanged at 100%, for ~16s of CI.
      One deliberate carve-out: `startup` stays a single best-of-15 spawn series
      even under `--gate` (spawn noise is one-sided, so min-of-N is the right
      estimator there, unlike the in-process benches). Do NOT "fix" the
      remaining variance by pinning: pinning shifts the ratio level 25-40% (it
      hurts node more than Lava) and would invalidate all 22 caps.
- [ ] **Host-native registry: consider moving `g_host_native_fns` onto
      `Runtime_State`** — it is read only at registration and in the sweep, never
      on the dispatch path (only `g_host_native_cbs` is), so keying it by the
      context pointer buys nothing and it could die with the state, deleting the
      sweep entirely. Not done here for a measured reason: the cache-HIT path is
      hot (~60k hits per 20k `fs.statSync`, three per `Stats` instance) and
      currently returns before any state lookup; moving the table would add
      `JSContextGetGlobalObject` + `JSObjectGetPrivate` to every hit. Needs a
      profile before committing to it.
- [ ] **Stack-trace line numbers are off by one** — the CommonJS wrapper
      prepends a line but `JSEvaluateScript` starts at line 1.
- [ ] **Two native-function divergences, both declared and pinned, neither
      repairable from the public C API** — recorded so nobody re-derives them.
      (a) On the host path `new setTimeout(fn)` evaluates to the CALL result,
      `undefined`, where Node (like any ordinary function) yields an object:
      `create_raw` reuses the call callback as the constructor slot. (b) On the
      C-API fallback every native reports `.length` 0 and is not constructible;
      `JSObjectSetProperty` cannot fix it, because `length` is inherited from
      `Function.prototype` so the call degrades to a `[[Set]]` against a
      non-writable slot. Both are analysed at `inject_native_function`
      (`require.odin`) and pinned — (a) by
      `host_native_construct_returns_call_result`, (b) by
      `host_native_create_declines_without_state` plus
      `tests/node-compat/cases/56-native-function-arity.js` for the default
      configuration. Fixing either needs a JS-level `defineProperty` during
      global installation; not worth it for a path taken only when the private
      ABI is missing.
- [ ] **Each `JSGlobalContext` costs one leaked `timerfd`** — JavaScriptCore's
      per-VM `WTF::RunLoop` timer. Measured 2026-07-29: +1 per context, strictly
      linear over 20 iterations, reproduced by a bare
      `JSGlobalContextCreate`/`Release` pair with no event loop, no script and no
      `Runtime_State`; unchanged by a forced `JSGarbageCollect`, by passing `nil`
      instead of our `JSClass`, or by waiting. One context running many scripts
      costs one fd, so the price is per VM. JSC's own GSource `finalize` does
      close it, so the fd survives because the VM is never finalized — the fix is
      getting the VM actually destroyed (or an upstream report), not a `close()`
      of our own. NOT a live defect in what we ship: one context per
      `lava run`/`lava eval` process and one per worker, both bounded. It bites
      the Odin test binary (hence the baseline-differential fd census in
      `cmd/lava/net_teardown_stress_test.odin`) and any embedder calling `eval`
      repeatedly in one process. Details at `release_global_context_after_eval`.
- [x] **Repeated `lava.eval` in one process degrades** — fixed: the thread-local
      host-call registry in `pkg/runtime/host_natives.odin` is keyed by the JSC
      context POINTER, and JSC reuses that address for a later
      `JSGlobalContextCreate`. Nothing dropped a dead context's entries, so from
      the 3rd-4th eval the key collided and the cache returned a `JSObjectRef`
      into freed memory — observed as the `allocUninit` binding resolving to
      `Map.prototype.values` out of `buffer.js` `createPool`, and as segfaults or
      tracking-allocator bad frees under the Odin test runner.
      Two lifetime bugs in the same tables, both fixed: (a) the ENTRIES were
      never dropped when a context died — `host_natives_release_context` now
      sweeps both tables from `destroy_runtime_state` while the context is still
      alive; (b) the map BACKING was bound implicitly to whatever
      `context.allocator` was live at the first insert (Odin binds a zero-valued
      map's allocator on first grow) even though the tables are thread-lived, so
      under the test runner's per-test tracking allocator, or an embedder's arena,
      later inserts wrote through reclaimed memory — both are now bound explicitly
      to a process-lifetime allocator. Pinned by `cmd/lava/repeated_eval_test.odin`
      and `cmd/lava/host_native_alloc_test.odin` (both mutation-verified in each
      direction). The pre-fix bug was not crash-only: a working proof-of-concept
      showed a native call running a DIFFERENT native's Odin callback, with the
      registration order steerable from user JS via `require()` order —
      embedder- and test-runner-reachable, not remotely. (Two earlier suspicions
      were wrong and are recorded as such: the `thread_local` probe state in
      `pkg/jsc/private_string.odin` is VM-independent and was never implicated,
      and the residual failure was not a separate defect in
      `pkg/runtime/eventloop/loop.odin`.)
- [ ] **Prototype-pollution hardening of the embedded JS layer** — `primordials.js`
      plus the `make check-primordials` ratchet over
      `tests/node-compat/pollution-baseline.json`. Done in the `method` column:
      `events.js`, `dns_promises.js`, `encoding.js`, and the encoding-name path
      of `buffer.js` — of which only `dns_promises.js` is 0 in all four classes.
      Remaining in `method`: `url.js` (the type-ambiguous
      `slice`/`indexOf`/`includes` sites, plus its percent-decode byte arrays,
      which are still plain arrays and so reachable via an `Array.prototype[0]`
      accessor), `buffer.js`, `path.js`, `esm.js`, `util.js`, and the newly
      in-scope `console.js`.
      **Unblocked**: the ratchet counts four classes separately, so that list is
      the `method` column only; the other three are recorded per file in
      `pollution-baseline.json` and are the larger part of the work. Read the
      current split from `make check-primordials` rather than from prose here —
      copied totals went stale twice. Take them per file, lowest-hanging first:
      capturing a module's globals at module-eval is mechanical and drives its
      `global` column to 0, which `encoding.js` already demonstrates. Note the
      `global` column counts the capture TABLE too, so `primordials.js` reads
      high there by construction and is not work.
- [x] **Real wall-clock timers** — fixed: in `real_time` mode the loop tracks the
      monotonic wall clock (`sync_real_clock` / `real_now_ms` in
      `pkg/runtime/eventloop/loop.odin`), so `setTimeout(fn, 1000)` fires after a
      second instead of immediately.
- [x] **`Buffer` offset/value/UTF-8 validation parity (#107)** — fixed:
      `write`/`fill`/`copy` reject negative & non-integer offsets (no wrap-around),
      the `write*` integer accessors range-check their value, the variable-width
      `read*`/`write*` require an integer `byteLength` 1..6, `fill` rejects an
      unrepresentable value (`ERR_INVALID_ARG_VALUE`), and `toString('utf8')` uses
      the Unicode maximal-subpart U+FFFD rule (`pkg/runtime/buffer.odin`). WHATWG
      `TextDecoder` now honors `{ stream: true }` and `fatal` for utf-8/utf-16le
      (`pkg/runtime/js/internal/encoding.js`). Verified vs Node 24 + Bun.
- [x] **Catchable oversized-`Buffer` allocations (#186)** — `Buffer.alloc`/
      `allocUnsafe` and raw `new Uint8Array(n)` past the practical JSC ceiling now
      throw a catchable `RangeError` instead of aborting the process (the
      `kMaxLength` cap + the typed-array allocation guard, #200).

### CI / tooling housekeeping

- [ ] **Give the gates one honest runner** — `make <target> | tail` reports
      **tail's** exit status, not make's, so a failing gate reads as a pass. This
      is not hypothetical: during the #320 review it hid a real `make test-lava`
      failure (the oracle diff was in the output text while the status said 0),
      and it is how `test-odin-serial` stayed green for a whole session while
      testing nothing. Wanted: a `make gates` that runs the routed set with real
      exit codes, stopping at the first failure, so neither a human nor an agent
      has to remember `set -o pipefail`. Until it exists, every gate claim in a
      PR body rests on the author having piped correctly.
- [ ] **A test-only fault-injection seam for JSC-side failures** — three
      safety-critical branches are accepted-untested today because the fault has
      to happen _inside_ JSC: the paired `map_insert` rollback in
      `host_native_create`, the `fillRandom` identity check in `crypto.js`, and
      `ensure_host`'s transient-vs-definitive retry. Each is code that only runs
      when an invariant is already broken, which is exactly the code least likely
      to be exercised and most expensive to get wrong. One env-gated seam
      (`LAVA_HOSTFN_DISABLE` is the precedent) unlocks all three.
- [ ] Pin a specific Odin release in CI (currently the `setup-odin` default) for
      reproducibility, and bump `llvm-version` if a newer Odin needs it. Newly
      concrete: this session turned on the fact that `ODIN_TEST_THREADS` is a
      compile-time `#config`, not an environment variable — runner semantics we
      now depend on in two targets, and which a silent `setup-odin` bump could
      change under us.
- [ ] Update `actions/checkout` / `actions/setup-node` past the Node 20
      deprecation warning.
- [x] Real `odin build` + run job for Windows: the CI Windows job links a
      JavaScriptCore-backed `lava.exe` (JSC from the Bun WebKit fork) and runs a
      runtime smoke, on top of type-check + codegen.
