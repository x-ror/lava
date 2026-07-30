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
      One vector remains on the author (an object literal indexed by a
      caller-supplied key needs `__proto__: null`), and two more are uncounted for
      two different reasons: `for…of`/spread/`Symbol.toPrimitive` read a well-known
      SYMBOL, so there is no named property to count, whereas `Object.prototype.then`
      is an ordinary named property the detector DOES count when written
      (`p.then(cb)` scores 1 `method`) and misses only when `await`/`Promise.resolve`
      read it implicitly. That last one is also a plain data property settable by an
      ordinary merge gadget — the sharpest uncounted vector, and its own item below.
- [x] **Route the network-facing regex validators through a captured `exec`** —
      done for `http.js` (9 sites), `url.js` (6) and `fetch.js` (1). Proven before
      being fixed, over a real socket against the actual server: with
      `RegExp.prototype.exec` replaced — an ordinary assignment, it is a writable
      data property — `Content-Length: abc` answered **200 OK** instead of 400 and
      `Transfer-Encoding: gzip` was accepted as chunked, while the other 18
      malformed-input checks kept passing. That is request smuggling.
      `RegExpPrototypeTest` was **removed** rather than fixed: the spec's RegExpExec
      re-reads `R.exec` off the receiver, so it steers a `test` captured pristine at
      module-eval and invoked through `Reflect.apply` — identical on node 24 and
      `bin/lava`. An export that looks safe and is not is worse than no export, so
      `RegExpPrototypeExec(re, s) !== null` is now the only spelling available.
      Pinned by two new `run-http-smoke.sh` phases that replay the whole
      malformed-input suite against a poisoned server, by vectors X1-X5 in
      `54-url-pollution.js` (node's URL is native and immune, so those are real
      differentials), by `cmd/lava/regexp_pollution_test.odin` for the header half —
      Lava-only because under the same poison node 24 **accepts**
      `Headers.set('X-Evil: 1\r\nInjected', 'v')`, undici's validator being
      JavaScript — and by six entries in `tests/mutation-manifest.json`.
      Four of the validators went further and dropped the regex entirely: a
      character-class check needs a `charCodeAt` loop, not a pattern, and with no
      RegExp in the expression `exec`/`test`/`Symbol.match`/`Symbol.replace`/
      `lastIndex` all drop out at once instead of one of them. It is also faster —
      0.82x-0.90x on `new URL`, min of 7 interleaved pinned launches per arm — which
      reversed the +6% to +20% regression the exec migration had introduced and that
      no benchmark covered.
- [ ] **The rest of the regex surface, and `.test` was not the whole of
      it** — a poisoned `exec` steers **six** methods, not two: `re.test`, `re.exec`,
      and `String.prototype.replace`/`match`/`search`/`split` whenever the argument
      is a regex, because all of them route through RegExpExec. Verified identically
      on node 24 and `bin/lava`. `matchAll` and a global `replace` are worse still —
      a forged result never advances `lastIndex`, so they spin: a 1.4 GB OOM in the
      probe that found this, i.e. a denial of service, not just a wrong answer.
      This also means **the ratchet's `method` column gives false comfort here**: a
      file can read `method 0` while calling `StringPrototypeReplace(s, /re/, x)`,
      because capturing `String.prototype.replace` does nothing about the `exec`
      re-read inside it. Another instance of "floor, not proof", and a sharper one
      than the accessor case, because the fix _looks_ applied.
      **No count in this prose, deliberately.** The previous version said "53 sites"
      with a per-module list that summed to 43, credited `sqlite.js` with a site it
      does not have (a bare grep scored `native.exec(...)`), and omitted `url.js`,
      `fetch.js`, `buffer.js` and `console.js` — two of which the commit above had
      just hardened. That is the third time a copied total went stale in this file,
      under the rule six entries up that forbids exactly this. Derive it instead:
      an acorn pass over `pkg/runtime/js` counting `re.test`/`re.exec` on a
      regex-shaped receiver plus `String.prototype.{replace,replaceAll,match,
      matchAll,search,split}` with a regex first argument. `esm.js` dominates by a
      wide margin and is the module loader, so it is next.
      The claim that none of the remainder was on the network path was **false**, and
      the four that were are now fixed rather than merely re-described:
      `fetch.js`'s header-value trim (which ran BEFORE the name validator on every
      `append`/`set`), and `url.js`'s tab/newline strip, IDNA separator fold and
      `hostFromDomainArg`. Each was a global replace, so under a forged `exec` they
      did not answer wrongly — they never returned. `new Headers().set('X-Ok','v')`
      and `new URL('http://EXAMPLE.com/')` both hung, and a remote server's
      `Location:` header reaching `new URL(location, req.url)` hung the client: a
      remote-triggerable DoS. The Lava-only test that pins them ran in 3m07s while
      they spun and runs in 34ms now.
- [x] **`util.format` ignored Node's single-argument rule** — fixed: a string
      first argument with nothing after it is returned verbatim, directives and
      all. Lava ran the substitution loop regardless and folded `%%` to `%`;
      exactly 8 rows of a 31-row contract probe against node 24 diverged, all of
      them `%%` with one argument. The directive cases (`%s`, `%z`, `100%`) already
      matched by a different route — the "arguments exhausted" branch re-emits
      `'%' + spec` — which is why the guard belongs before the loop, not in it.
      Both implementations were wrong: `internal/util.js` behind `util.format`, and
      `console.js`'s own `formatArgs` behind `console.log`. The duplication stays,
      justified: `console.js` is the bootstrap prelude, takes the native write
      functions as arguments, and has no `require` to delegate with.
      Pinned by `57-format-single-arg.js` and TWO manifest entries — removing one
      guard leaves the other path correct, so a single entry would have reported
      coverage it did not have.
      Latent rather than live when found: no committed case contained `%%`, so
      nothing was mis-comparing. A future one would have, silently, on both sides.
- [ ] **`decode-utf16le` breaches its cap ~3 runs in 8, and `bench-gate` is not in
      CI** — measured 2026-07-30 over 8 `--gate` runs: 11.07x, 14.01x, 14.44x,
      14.63x, 15.22x, 15.61x and two unrecorded passes, against a 14.5 cap. The cap
      was recalibrated 2026-07-28 to "~1.4x the fresh idle-box median-of-3" from a
      9.8x measurement; the median now reads ~14.3x. Either the box differs or
      decode-utf16le regressed ~46% in two days — not guessed at here, because
      `make bench-gate` runs in no CI job, so nothing would have caught either.
      This is the exact failure `thresholds.json` warns about in its own note ("a
      light that fires on one clean run in four ... trains reviewers to re-run"),
      now firing on one of its own caps. It also blocks wiring the URL bench's cap
      into the mutation gate: that gate refuses a red baseline, correctly, and
      `make test-mutation` is in CI.
      First step is deciding which of the two it is — rebuild at the 2026-07-28 tip
      and re-measure on the same box, rather than widening the cap and losing the
      detector.
- [ ] **`Object.prototype.then` is an uncounted, easily-set pollution vector** —
      a plain data property, so an ordinary merge/`obj[a][b]=c` gadget sets it,
      no `defineProperty` needed. Verified under `bin/lava`: `await { plain: 1 }`
      and `Promise.resolve(obj)` both execute attacker code inside an internal
      await, and internals carry 5 awaits plus ~31 `.then(` sites. The ratchet
      cannot see the implicit read (an explicit `p.then(cb)` IS counted, as
      `method`; `await x` and `Promise.resolve(x)` carry no member expression to
      count), so this needs a code convention instead: never `await` a
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
      `events.js`, `dns_promises.js`, and the encoding-name path of `buffer.js`;
      `encoding.js` sits at 1, not 0. Six files are 0 in all four classes, but
      none of them is evidence of hardening — every one is a 6–19 line re-export
      shim (`console.js`, `dns_promises.js`, `path_posix.js`, `path_win32.js`,
      `process.js`, `timers.js`). No file with real logic is clean in all four.
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
      `global` column to 0, which `encoding.js` already demonstrates. Note
      `primordials.js` reads 9 in `invoke` **by construction** — every `callerN`
      wrapper is a `fn.call` — while its `global` column is 1, because the
      module-eval rule already exempts the capture table. Neither is work.
      **Next, and it is the largest single win left**: wire `lockIntrinsics()`.
      It is written and exported in `primordials.js` and called from nowhere, so
      the whole `invoke` class is live today. Now that the class is counted it is
      also measurable, and the exposure is worse than the "exotic axis" the file
      header used to call it: replacing `Function.prototype.call` makes Lava throw
      where Node succeeds (TextDecoder/TextEncoder construction, `Buffer.from`,
      `buf.toString`, `Buffer.concat`, `new URL`) and — worse — answer _wrongly_
      where Node is right (`URLSearchParams.get` → `null`, `util.format` →
      `'undefined'`). Not hypothetical: instrumentation and tracing libraries wrap
      `Function.prototype.call` for legitimate reasons.
      Converting the wrappers to `Reflect.apply` instead was measured and is not
      the answer for the hot ones — `bin/lava` vs a build with `caller0..3`
      rewritten, end to end: `new URL` 1.76x, `EventEmitter.emit` 1.63x,
      `decode(5B)` 1.49x, `URLSearchParams.get` 1.41x, `toString('hex')` 1.28x,
      TextDecoder ctor 1.21x, `decode(1800B)` 1.11x. URL parsing and event
      emission are on every HTTP request, so ~1.7x there is not payable.
      But the same table says the conversion is **free** (~1.00x) for
      `Buffer.from`, `TextEncoder.encode`, `util.format`, `path.join` and
      `structuredClone`, so the work splits cleanly: `lockIntrinsics()` at
      bootstrap for the hot paths at zero per-call cost, and `Reflect.apply` for
      the wrapper-sparse cold ones regardless.
      One site is already done, and it shows a third option worth looking for
      first: `encoding.js` reached the utf-8 and utf-16le decoders as
      `Buffer.prototype.toString.call(bytes, enc)`, which put the live `.call` read
      on decode()'s **return** path — `decode()` handed back the replacement's
      ArrayBuffer instead of a string. It now takes `utf8Decode`/`utf16leDecode`
      straight from the loader's native argument, which needs no `Function.prototype`
      read at all and is FASTER than the `.call` it replaced (0.74x on a 9-byte
      decode, 0.91x on a 20-parameter URLSearchParams parse, medians of 7
      interleaved launches) because toString's length getter, range clamp and
      encoding-name dispatch drop out. Pinned by vector V in
      `55-encoding-pollution.js`. Where a JS layer is borrowing a prototype method
      that only wraps a native we already own, going to the native beats both
      `.call` and `Reflect.apply` — check for that before reaching for either. The open question is only
      `lockIntrinsics()`'s own Node deviation — Node leaves the intrinsics
      writable, so a program assigning `Function.prototype.call` would silently
      not take effect; that narrower divergence needs a Lava-only test pinning it
      per §1, plus a full `make test-lava` pass to find what in the oracle suites
      legitimately writes an intrinsic.
- [x] **`run_until_idle` ended the drive on one no-progress tick** — fixed: it
      now keeps polling while `active_io_count` or `active_async` is nonzero, the
      invariant `run()` has carried since #113 (ba12bd3) and which that fix reached
      only on `run()` — its own comment says so, "(run_until_idle keeps its bounded
      form for deterministic tests)", and the bounded form silently kept the early
      return too.
      A no-progress tick is routine, not exceptional: `post_async` appends the
      completion under `async_mutex` and writes the wakeup byte after unlocking,
      while the poll drains the pipe and `drain_async` drains the queue at different
      instants — and `drain_async` takes the whole queue per pass, so one byte can
      carry two completions and leave a surplus byte that pops the next blocking
      poll with nothing to drain. Draining a wakeup deliberately does not count as
      I/O progress, so that tick reports `false`, and the old code returned the
      `did_work` an earlier tick had latched. It therefore read as SUCCESS, which is
      why it survived: CI saw 2-of-3 completions with `active_async == 1` and no
      failure on the `run_until_idle` assertion itself.
      Found by a one-off CI failure in
      `threadpool_runs_work_offloop_and_completes_on_loop`, at roughly 1-2% per run
      under CI's 4-core oversubscription — 40 solo runs, 25 whole-suite runs and 20
      runs under `taskset -c 0,1` on a 16-core box all came back clean, so the
      reproduction had to come from reading the driver rather than from load.
      Pinned by `run_until_idle_waits_out_a_stale_wakeup`, which is the existing
      `run_ignores_stale_wakeup_while_async_is_active` with `run` swapped for
      `run_until_idle` — the hazard already had a test, on the other driver only.
      It carries NO timer on purpose: a pending timer gives `platform_poll` a
      positive timeout, and a positive-timeout poll counts as progress by itself, so
      the no-progress tick never happens and the bug hides. A first version used a
      timer to avoid the thread, passed, and passed just as well with the fix
      reverted.
      `scripts/run-tests.sh` also ran this suite multithreaded while
      `make test-eventloop-odin` pinned one thread for a stated reason, so CI
      contradicted the documented requirement; aligned. That is not the race fix —
      the defect reproduces at one thread, and deterministically with no threadpool
      at all (`async_begin` plus a `set_immediate` that calls `wakeup` returns in
      ~9us with `active_async == 1`).
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
