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
implementations — no `primordials`, no `internalBinding` coupling.

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

- [x] **Promise ↔ event-loop ordering.** JSC drains its own promise microtask
      queue at every C-API boundary, so `Promise.then` used to run *before*
      `process.nextTick` (Node is the reverse). `queueMicrotask` lives in a JS shim
      (`js/internal/microtasks.js`) that schedules a JSC microtask, so it shares one
      FIFO with promise jobs. `process.nextTick` keeps Node's **absolute** priority
      by *not* living in JSC's queue: nextTick callbacks accumulate in a JS-owned
      queue, and native drains it at two checkpoints that recreate Node's
      `do { drain nextTicks; run microtasks } while (nextTicks)` loop on top of
      JSC's auto-drain — checkpoint 1 (`dispatch`) runs every event-loop callback
      and drains nextTicks before returning across the C boundary (so a nextTick
      beats a promise job queued earlier in the same turn); checkpoint 2 re-drains
      after JSC auto-drains the promise jobs (so a nextTick queued *first inside a
      microtask* still runs after the microtask queue empties). The top-level turn
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
      supplies narrow socket primitives plus a swappable TLS backend
      (`pkg/runtime/fetch_tls.odin`). Implemented for **Linux** (io_uring/epoll,
      `core:sys/linux`), **macOS** (kqueue, `core:sys/posix`), and **Windows**
      (`select`, Winsock). TLS uses OpenSSL (`pkg/runtime/tls.odin`); on Windows the
      machine certificate store is loaded into OpenSSL's trust store. DNS resolves
      off the loop on a worker thread. All three platforms build and run for real in
      CI — the Windows job links a JavaScriptCore-backed `lava.exe` and runs it.
      Follow-ups: native Security.framework TLS on macOS (#143), streaming bodies
      (#31), a resolved-address list for IPv6 hostnames + Happy Eyeballs (#145), and
      HTTP correctness (#99).
- [x] **Event-loop I/O driving** — fetch was the first real `watch_fd` consumer
      and exposed several gaps, now fixed (`pkg/runtime/eventloop/`):
      - io_uring `POLL_ADD` mask is written to `poll_events` (was `addr`, so no
        fd poll ever fired) and SQEs are submitted at arm time (not only at the
        next `poll`, which a due timer could skip indefinitely).
      - `run_until_idle` blocks in `poll` when a socket is the only pending work,
        and advances the virtual clock on a timer-deadline wake so a timer
        co-pending with I/O is not dropped.
      - timer delays are floored at 1ms (Node parity), so a 0ms timer cannot
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

- [ ] **`clearInterval` leaks** the `JS_Callback` heap binding + GC protection
      (the loop drops the timer without firing the trampoline that frees it).
- [ ] **`setTimeout`/`setInterval` ignore extra trailing args** (Node forwards
      them to the callback).
- [ ] **Stack-trace line numbers are off by one** — the CommonJS wrapper
      prepends a line but `JSEvaluateScript` starts at line 1.
- [ ] **Real wall-clock timers** — the loop advances a logical clock in
      `run_until_idle`; `setTimeout(fn, 1000)` fires immediately rather than
      after a second.

### CI / tooling housekeeping

- [ ] Pin a specific Odin release in CI (currently the `setup-odin` default) for
      reproducibility, and bump `llvm-version` if a newer Odin needs it.
- [ ] Update `actions/checkout` / `actions/setup-node` past the Node 20
      deprecation warning.
- [x] Real `odin build` + run job for Windows: the CI Windows job links a
      JavaScriptCore-backed `lava.exe` (JSC from the Bun WebKit fork) and runs a
      runtime smoke, on top of type-check + codegen.
