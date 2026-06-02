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
- [x] **`JSC_GTK6` build toggle** threaded through the Makefile + `scripts/build.sh`.

## Remaining

Tracked against the `tests/node-compat/cases` oracle. Through Lava today:
`00-commonjs` and `02-fs-path` pass; the rest are blocked on the items below.

### High priority (unblocks async + the compat suite)

- [ ] **Promise ↔ event-loop integration.** JSC drains its own promise
      microtask queue at the end of `JSEvaluateScript`, so `Promise.then` runs
      *before* `process.nextTick` (Node is the reverse). Bind
      `JSObjectMakeDeferredPromise` and route promise jobs through our
      next-tick/microtask queues. _(originally the "+ DeferredPromise" half of
      plan item 1)_
- [ ] **`Buffer` global** — real `Buffer.from`/`alloc`/`concat`, etc.
      `readFileSync` currently returns a bare `Uint8Array`. _(blocks `03-buffer`)_
- [ ] **`node:assert` is a no-op** (`equal`/`deepEqual`/`match` do nothing) —
      `pkg/runtime/environment.odin`. Implement real assertions; dangerous for a
      test-runner target until then.

### Medium priority (more of the Node surface)

- [ ] **`events` (EventEmitter)** — _(blocks `06-events`)_
- [ ] **`node:crypto`** subset — _(blocks `07-crypto`)_
- [ ] **`fetch` / `TextEncoder` / `TextDecoder` / `structuredClone`** —
      _(blocks `08-fetch`)_
- [ ] **ESM** — only CommonJS `require` works; no `.mjs` / `import`
      _(blocks `01-esm`)_
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
