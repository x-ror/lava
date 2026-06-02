# Lava roadmap

Status of the Node.js port. Baseline target: Node 22 on JavaScriptCore, with a
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
- [x] **Memory** — `free_all` the temp arena at the require boundary;
      single-allocation JS→string conversion.
- [x] **Windows support** — `pkg/jsc/bindings_windows.odin`
      (`system:JavaScriptCore.lib`), OS-aware path helpers; IOCP backend already
      existed.
- [x] **CI** — `.github/workflows/ci.yml`: full check/build/test on Linux
      (`javascriptcoregtk-6.0`) and macOS; type-check + codegen + JSC-free
      event-loop tests on Windows.

## Remaining

Tracked against the `tests/node-compat/cases` oracle. Through Lava today
**8 of 9 cases pass** (`00`,`02`–`08`); only `01-esm` remains, blocked on the
ESM loader below.

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
      `Uint8Array` with hand-rolled utf8/hex/base64 — _(passes `03-buffer`)_
- [x] **`node:crypto`** subset — pure-JS `createHash('sha256')`, `randomUUID`,
      `randomBytes` — _(passes `07-crypto`)_
- [x] **`fetch` / `Response` / `Headers` / `Request`** globals — body + headers
      machinery is real; network transport is stubbed — _(passes `08-fetch`)_

### High priority (the Odin / native part)

- [ ] **Promise ↔ event-loop integration.** JSC drains its own promise
      microtask queue at the end of `JSEvaluateScript`, so `Promise.then` runs
      *before* `process.nextTick` (Node is the reverse). Bind
      `JSObjectMakeDeferredPromise` and route promise jobs through our
      next-tick/microtask queues. _(originally the "+ DeferredPromise" half of
      plan item 1)_
- [ ] **ESM** — only CommonJS `require` works; no `.mjs` / `import` /
      `import.meta` / `node:url` `fileURLToPath` _(blocks `01-esm`, the last
      failing case)_
- [ ] **Native CSPRNG** — `crypto.randomBytes`/`randomUUID` currently use
      `Math.random` (format-correct, NOT secure). Wire an OS entropy binding.
- [ ] **Real network transport for `fetch()`** — Response/Headers exist; the
      transport rejects until sockets are bound.

### Medium priority (more of the Node surface)

- [ ] **`TextEncoder` / `TextDecoder` / `structuredClone`** globals (pure JS;
      reuse the buffer utf8 codec).
- [ ] **More `node:path`** — `resolve`, `relative`, `normalize`, `dirname`,
      `sep`, `posix`/`win32` namespaces (only `basename`/`join`/`extname`/
      `isAbsolute` today).
- [ ] **More `node:fs`** — `writeFileSync`, `mkdirSync`, `statSync`, `readdirSync`,
      async variants.
- [ ] **Wire `pkg/std/sqlite`** — currently stubbed
      (`Native_SQLite_Unavailable`).

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
- [ ] Add a real `odin build` + run job for Windows once a prebuilt WebKit
      `JavaScriptCore.dll`/`.lib` is vendored (today: type-check + codegen only).
