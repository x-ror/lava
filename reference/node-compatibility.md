# Lava ↔ Node.js API compatibility matrix

Coverage of the Node.js public API surface in **lava**.

- **Node docs source:** `nodejs/node` `doc/api` @ the commit recorded in [node-doc-api/SOURCE.txt](node-doc-api/SOURCE.txt) (70 pages, mirrored under [node-doc-api/](node-doc-api/)).
- **lava revision measured:** `3de9128` (HEAD at generation time).
- **Method:** every row was probed against the built `bin/lava` (`require('node:x')`, global lookups, and calling representative functions) — not inferred from source. Stub functions that exist but throw `"... is not implemented in Lava"` are counted as *not* implemented.

**Legend:** ✅ implemented (substantial) · 🟡 partial (core works, notable gaps or many stubs) · 🟥 missing (`require` throws `MODULE_NOT_FOUND`) · ⚪ N/A for a JS-API matrix (native-addon / CLI / conceptual guide).

## Scoreboard

| Status | Count | Modules / surfaces |
|--------|------:|--------------------|
| ✅ Full | 7 | assert, buffer, events, intl*, path, sqlite, url |
| 🟡 Partial | 15 | console, crypto, esm, fs, globals, module/modules, packages, perf_hooks, process, timers, util, webcrypto, webstreams, environment_variables |
| 🟥 Missing | 38 | net, http(s), http2, stream, dns, dgram, tls, os, zlib, child_process, worker_threads, querystring, string_decoder, async_hooks, readline, repl, vm, v8, test, … |
| ⚪ N/A | 10 | addons, cli, debugger, deprecations, documentation, embedding, errors, index, n-api, synopsis |

\* `intl` is provided by the JavaScriptCore engine, not by lava code.

## Requireable modules

| Module | `node:` | Status | Implemented | Key gaps | Source |
|--------|:------:|:------:|-------------|----------|--------|
| **assert** | ✅ | ✅ | ok/equal/strict*/deep*/match/throws/rejects/ifError + `assert/strict` (19 exports), `AssertionError` | snapshot/`partialDeepStrictEqual` niceties | [js/internal/assert.js](../pkg/runtime/js/internal/assert.js) |
| **buffer** | ✅ | ✅ | `Buffer` (full read/write/encode/search, Node-coded errors, `util.inspect` `<Buffer ..>`, `poolSize` allocation pooling), `Blob`, `File`, `SlowBuffer`, `atob`/`btoa` (module-scoped), `isAscii`/`isUtf8`, `transcode`, `resolveObjectURL` (+ global `URL.createObjectURL`/`revokeObjectURL`) | large `allocUnsafe`/`allocUnsafeSlow`/`SlowBuffer` are natively uninitialized (capped at `2^31-1`, then a zero-filled fallback) — see notes | [buffer.odin](../pkg/runtime/buffer.odin), [js/internal/buffer.js](../pkg/runtime/js/internal/buffer.js) |
| **events** | ✅ | ✅ | `EventEmitter` (on/once/off/emit/listeners/prepend/…), static `once`, `defaultMaxListeners` | `EventTarget`/`CustomEvent`, `events.on`/`getEventListeners`, captureRejections | [js/internal/events.js](../pkg/runtime/js/internal/events.js) |
| **path** | ✅ | ✅ | all of posix + win32 (resolve/normalize/join/relative/dirname/basename/extname/parse/format/isAbsolute/toNamespacedPath) | — | [js/internal/path.js](../pkg/runtime/js/internal/path.js) |
| **sqlite** | ✅ | ✅ | `DatabaseSync`, `StatementSync` (prepare/all/get/run/columns/bind/named params/BigInt) | session/backup, `Symbol.asyncDispose` | [sqlite.odin](../pkg/runtime/sqlite.odin), [js/internal/sqlite.js](../pkg/runtime/js/internal/sqlite.js), [pkg/std/sqlite](../pkg/std/sqlite/) |
| **crypto** | ✅ | 🟡 | **real:** createHash/Hash, createHmac/Hmac, `hash`, randomBytes, randomFill(Sync), randomInt, randomUUID, pbkdf2(Sync), hkdf(Sync), **scrypt(Sync)** (RFC 7914, layered on PBKDF2), timingSafeEqual, getHashes (with **OpenSSL/Node digest aliases** — `RSA-SHA256`, `sha256WithRSAEncryption`, `ssl3-md5`, … normalized to canonical names), getFips (0). Full Node surface is exported but **~45 fns throw "not implemented"** | ciphers (`createCipheriv`), keys (`generateKeyPair*`, `createPrivateKey`), sign/verify, `X509Certificate`, `ECDH`, `DiffieHellman`, primes, `argon2`, `webcrypto`/`subtle`; digests Odin lacks (`ripemd160`, `shake128/256`, `sha512-224`, `md5-sha1`) are rejected | [crypto.odin](../pkg/runtime/crypto.odin), [js/internal/crypto.js](../pkg/runtime/js/internal/crypto.js) |
| **fs** | ✅ | 🟡 | readFile(Sync)/writeFile(Sync), existsSync, mkdirSync, mkdtempSync, rmSync/rmdirSync, unlinkSync, renameSync, statSync (rich `Stats`), readdirSync (13 exports) | no `fs.promises`, no streams/watch, no copyFile/access/chmod/chown/open/read/appendFile/realpath/symlink, callbacks only on read/write | [fs.odin](../pkg/runtime/fs.odin), [require.odin](../pkg/runtime/require.odin) |
| **util** | ✅ | 🟡 | `inspect`, `format`, `formatWithOptions` (3 exports) | `promisify`, `callbackify`, `types.*`, `inherits`, `deprecate`, `isDeepStrictEqual`, `parseArgs`, `styleText`, `TextEncoder` re-export, `MIMEType` | [js/internal/util.js](../pkg/runtime/js/internal/util.js) |
| **url** | ✅ | ✅ | WHATWG `URL` (constructor, all getters/setters, `origin`, `searchParams`, `toString`/`toJSON`, static `canParse`/`parse`) + `URLSearchParams` (get/getAll/set/append/delete/has/sort/forEach/iteration/`size`), both also installed as globals; `fileURLToPath`, `pathToFileURL`, `urlToHttpOptions`, `format`, `domainToASCII`/`domainToUnicode` | legacy `url.parse`/`url.resolve`/`url.Url` (deprecated upstream); IDNA host mapping is approximated (NFKC+Punycode, not full ICU UTS-46); Node-specific port-setter and non-special-scheme host-setter quirks for malformed values | [js/internal/url.js](../pkg/runtime/js/internal/url.js) |
| **timers** | ❌ | 🟡 | globals setTimeout/Interval/Immediate + clear*; **`node:timers/promises` ✅** (setTimeout/setImmediate/setInterval/scheduler) | `require('node:timers')` is `MODULE_NOT_FOUND`; no `.ref()`/`.unref()`/`.refresh()` on handles | [globals.odin](../pkg/runtime/globals.odin), [js/internal/timers_promises.js](../pkg/runtime/js/internal/timers_promises.js) |
| **console** | ❌ | 🟡 | global `console` is rich (log/info/warn/error/dir/trace/assert/time*/count*/group*/table/clear) | `require('node:console')` / `Console` class constructor not exported | [js/console.js](../pkg/runtime/js/console.js) |
| **process** | ❌ | 🟡 | global `process`: argv, env, cwd(), exit(), nextTick(), pid, platform, arch, version, versions | hrtime, chdir, kill, memoryUsage, uptime, stdout/stderr/stdin, execPath, argv0, event-emitter (`on`/signals), `require('node:process')` | [globals.odin](../pkg/runtime/globals.odin) |
| **perf_hooks** | ❌ | 🟡 | global `performance.now()` / `timeOrigin` | `PerformanceObserver`, marks/measures/entries, `monitorEventLoopDelay`, module form | [globals.odin](../pkg/runtime/globals.odin) |
| **module** / **modules** | ❌ | 🟡 | CommonJS `require` + `node:` resolution; ESM `.mjs` transform | `module.createRequire`, `register`, `isBuiltin`, `SourceMap`, `module.exports` resolve API | [require.odin](../pkg/runtime/require.odin), [js/internal/esm.js](../pkg/runtime/js/internal/esm.js) |
| **net** | ❌ | 🟥 | — | `Socket`, `Server`, `connect`, `createServer` | — |
| **tls** | ❌ | 🟥 | (used internally by fetch; not exposed) | `TLSSocket`, `connect`, `createSecureContext` | — |
| **http** | ❌ | 🟥 | — | `request`, `createServer`, `Agent` (fetch covers the client side — GET/POST, streaming response bodies, streaming chunked request bodies) | — |
| **https** | ❌ | 🟥 | — | same as http over TLS | — |
| **http2** | ❌ | 🟥 | — | entire module | — |
| **stream** | ❌ | 🟥 | — | Node `Readable`/`Writable`/`Duplex`/`Transform`, `pipeline`, `finished` (the **Web** Streams live in `node:stream/web` — see `webstreams` — but the classic `node:stream` object-mode API and `node:stream` ↔ Web Stream bridging are not wired yet) | — |
| **dns** | ❌ | 🟥 | internal IPv4-only resolver inside fetch; **no public module** | `lookup`, `resolve*`, `Resolver`, `reverse` (implementation in progress) | [fetch_transport.odin](../pkg/runtime/fetch_transport.odin) |
| **dgram** | ❌ | 🟥 | — | UDP `Socket` | — |
| **os** | ❌ | 🟥 | — | platform/arch/cpus/hostname/networkInterfaces/homedir/tmpdir/… | — |
| **zlib** | ❌ | 🟥 | — | gzip/deflate/brotli (sync + streams) | — |
| **querystring** | ❌ | 🟥 | — | parse/stringify/escape/unescape | — |
| **string_decoder** | ❌ | 🟥 | — | `StringDecoder` | — |
| **child_process** | ❌ | 🟥 | — | spawn/exec/fork/execFile | — |
| **worker_threads** | ❌ | 🟥 | — | `Worker`, `MessagePort`, `parentPort` | — |
| **cluster** | ❌ | 🟥 | — | entire module | — |
| **async_hooks** | ❌ | 🟥 | — | `AsyncLocalStorage`, `AsyncResource`, hooks | — |
| **readline** | ❌ | 🟥 | — | `Interface`, `createInterface` | — |
| **repl** | ❌ | 🟥 | — | `REPLServer` | — |
| **vm** | ❌ | 🟥 | — | `Script`, `createContext`, `runInContext` | — |
| **v8** | ❌ | 🟥 | — | serialize/deserialize, heap stats | — |
| **test** | ❌ | 🟥 | — | `node:test`, `describe`/`it`, mocks | — |
| **tty** | ❌ | 🟥 | — | `isatty`, `ReadStream`/`WriteStream` | — |
| **webstreams** | 🟡 | 🟡 | `ReadableStream`/`WritableStream`/`TransformStream` (+ default readers/writers/controllers and `ByteLengthQueuingStrategy`/`CountQueuingStrategy`) as globals and via `require('node:stream/web')`; `getReader`/`read`/async iteration/`cancel`/`tee`/`locked`/`pipeTo`/`pipeThrough`, desiredSize backpressure; backs `response.body` and is accepted as a request body | byte streams / BYOB (`type:'bytes'`, `mode:'byob'`) deferred and reported explicitly; no `TextEncoderStream`/`TextDecoderStream`/`CompressionStream` | [js/internal/streams.js](../pkg/runtime/js/internal/streams.js) |
| **webcrypto** | ❌ | 🟡 | global `crypto.getRandomValues`, `crypto.randomUUID` | `crypto.subtle` (all SubtleCrypto) | [globals.odin](../pkg/runtime/globals.odin) |
| **diagnostics_channel** | ❌ | 🟥 | — | channels/subscribe | — |
| **inspector** | ❌ | 🟥 | — | inspector session/console | — |
| **domain** | ❌ | 🟥 | — | (deprecated upstream) | — |
| **punycode** | ❌ | 🟥 | — | (deprecated upstream) | — |
| **wasi** | ❌ | 🟥 | — | `WASI` (WebAssembly engine present, WASI glue not) | — |
| **ffi** / **quic** / **dtls** / **vfs** | ❌ | 🟥 | — | newer/experimental Node modules | — |
| **permissions** / **report** / **trace_events** / **single-executable** | ❌ | 🟥 | — | runtime tooling surfaces | — |

## Globals (`globalThis`)

Probed directly against `bin/lava`.

**Present (37):** `global`, `globalThis`, `Buffer`, `fetch`, `Headers`, `Request`, `Response`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`, `structuredClone`, `queueMicrotask`, `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `console`, `process`, `performance`, `Blob`, `File`, `crypto` (getRandomValues/randomUUID), `URL` (full WHATWG constructor + `createObjectURL`/`revokeObjectURL`), `URLSearchParams`, the Web Streams family — `ReadableStream`, `WritableStream`, `TransformStream`, `ReadableStreamDefaultReader`, `ReadableStreamBYOBReader` (deferred; see below), `ReadableStreamDefaultController`, `WritableStreamDefaultWriter`, `WritableStreamDefaultController`, `TransformStreamDefaultController`, `ByteLengthQueuingStrategy`, `CountQueuingStrategy` — plus engine-provided `WebAssembly` and `Intl`.

`fetch` streams bodies in **both** directions on the public Web Streams type. `response.body` is a real `ReadableStream` (incrementally fed by the transport — `getReader().read()`, `for await…of`, `cancel()`, `tee()`, `locked`, `pipeTo`, `pipeThrough`), and the buffered accessors `text()`/`json()`/`arrayBuffer()`/`bytes()` drain that same stream (single-consumption enforced). On the request side, a `ReadableStream` or async-iterable body is **streamed incrementally as `Transfer-Encoding: chunked`** — pulled one chunk at a time and written to the socket with write backpressure, never materialized in full (`duplex: 'half'` is required for stream bodies, matching Node). A `Blob` (a known-length body) and string/`Buffer`/typed-array bodies keep the buffered `Content-Length` fast path. fetch and `node:stream/web` share one stream implementation ([js/internal/streams.js](../pkg/runtime/js/internal/streams.js)), so there is no fetch-only fork. Intentional limitations vs Node: streaming is **half-duplex** (the whole request body is sent before the response is read); an immediately-empty stream body is sent as an empty chunked body (terminator only) rather than `Content-Length: 0` (the received body is identical); and a server that rejects chunked request bodies — or closes the connection mid-upload — surfaces as a failed request. The standalone `ReadableStream`/`WritableStream` globals are still not exposed.

**Missing:** `atob`, `btoa` (global form), `Event`, `EventTarget`, `CustomEvent`, `ReadableStreamBYOBRequest`/`ReadableByteStreamController` (byte streams deferred), `TextEncoderStream`/`TextDecoderStream`, `CompressionStream`/`DecompressionStream`, `MessageChannel`/`MessagePort`, `Worker`, `BroadcastChannel`, `navigator`, `reportError`, `crypto.subtle`.

## Web Streams surface

WHATWG Web Streams ([js/internal/streams.js](../pkg/runtime/js/internal/streams.js)) are exposed both as globals and through `require('node:stream/web')` (the global and the module export the same class objects, as in Node). `fetch` builds `response.body` and consumes user-provided request bodies through this same `ReadableStream`, so there is a single stream implementation rather than a fetch-only fork. Verified by `tests/node-compat/cases/25-web-streams.js` (`make test-compat-lava`) and the streaming/`pipeTo`/`pipeThrough` cases in `make test-fetch-smoke`.

**Supported (Node-parity):**

- **`ReadableStream`** (default/chunk source): `new ReadableStream(underlyingSource, strategy)` with `start`/`pull`/`cancel`; `getReader()`, `read()`, `releaseLock()`, `reader.closed`/`cancel()`; `[Symbol.asyncIterator]` / `values()` (with early-break cancellation); `cancel()`, `tee()`, `locked`; `pipeTo()` and `pipeThrough()` (incl. `preventClose`/`preventAbort`/`preventCancel` and an `AbortSignal`); `ReadableStreamDefaultController` with `enqueue`/`close`/`error`/`desiredSize` and `pull`-driven, high-water-mark backpressure.
- **`WritableStream`**: `new WritableStream(underlyingSink, strategy)` with `start`/`write`/`close`/`abort`; `getWriter()`, `write()`, `close()`, `abort()`, `releaseLock()`, `writer.ready`/`closed`/`desiredSize`; `WritableStreamDefaultController.error`. Implemented to the level `pipeTo` needs and generally usable directly.
- **`TransformStream`**: `new TransformStream(transformer, writableStrategy, readableStrategy)` with `start`/`transform`/`flush`; `readable`/`writable`; `TransformStreamDefaultController` `enqueue`/`error`/`terminate`/`desiredSize`; readable↔writable backpressure coupling. The default (no-`transform`) transformer is an identity pass-through, matching Node.
- **Queuing strategies:** `ByteLengthQueuingStrategy` and `CountQueuingStrategy` (`highWaterMark`, `size`).
- **Error/cancellation propagation:** controller `error()`, a throwing `transform`, a failing sink `write`, reader/writer lock violations, and abort-during-`pipeTo` all settle the right side and reject the right promise, matching Node (compared by error constructor; see "intentional differences").

**Deferred (reported explicitly, not silently wrong):**

- **Byte streams / BYOB.** `new ReadableStream({ type: 'bytes' })` throws a clear `TypeError` rather than degrading to a default stream; `stream.getReader({ mode: 'byob' })` throws a `TypeError` (this matches Node for a non-byte stream). `ReadableStreamBYOBReader` exists as a global constructor (so `typeof` matches Node) but constructing one reports the deferral. `ReadableStreamBYOBRequest`/`ReadableByteStreamController` are not exposed. Tracked as a follow-up.

**Intentionally unsupported here:**

- `TextEncoderStream` / `TextDecoderStream`, `CompressionStream` / `DecompressionStream`. (Node provides them via `node:stream/web`; Lava omits them for now — use the buffered `TextEncoder`/`TextDecoder` globals.)

**Intentional differences from Node:**

- Error **messages** carry Lava wording, not Node/undici wording; error **types** (`TypeError`/`RangeError`) and names match. Tests compare by constructor name.
- Web Streams use Promise-based microtask scheduling; fine-grained interleaving of stream microtasks with unrelated work may differ from Node, but per-stream ordering and delivered values do not.
- `node:stream` (the classic object-mode `Readable`/`Writable`) and `node:stream` ↔ Web Stream bridging are not implemented; only `node:stream/web` is.

## `Buffer` surface

`Buffer` is a clean-room `Uint8Array` subclass ([js/internal/buffer.js](../pkg/runtime/js/internal/buffer.js)) over Odin codec primitives for the hot paths ([buffer.odin](../pkg/runtime/buffer.odin)). Its own-property API surface matches Node exactly (verified by `make api-surface`). Ported Bun buffer cases live under [tests/node-compat/bun-buffer/ported](../tests/node-compat/bun-buffer/ported) and run via `scripts/report-bun-buffer-tests.sh` (or `make bun-buffer-tests`) and `make test-compat-lava`.

**Supported (Node-parity):**

- **Constructors / statics:** `Buffer.from` (string, `Array`, array-like objects, `ArrayBuffer`/`SharedArrayBuffer` views that *share* memory, `TypedArray`/`DataView` copies, boxed primitives via `valueOf`/`Symbol.toPrimitive`, and `{type:'Buffer',data:[…]}` JSON revival), `Buffer.alloc`/`allocUnsafe`/`allocUnsafeSlow` (with size validation), `Buffer.of`, `Buffer.concat` (with `list`/element validation), `Buffer.isBuffer`, `Buffer.isEncoding`, `Buffer.byteLength` (string + `ArrayBuffer`/`TypedArray`/`DataView`), `Buffer.compare`, `Buffer.copyBytesFrom`.
- **Instance:** `toString`/slice writers (all encodings), `write`, `slice`/`subarray` (shared-memory views), `copy` (incl. overlapping), `equals`, `compare` (with ranges), `indexOf`/`lastIndexOf`/`includes` (string/number/Buffer needles, encodings, negative offsets), `fill` (number/string/Buffer, regions, encodings), `swap16`/`swap32`/`swap64`, all fixed-width and variable-width `read*`/`write*` integer/float accessors, `readBig*`/`writeBig*` 64-bit, `toJSON`.
- **Encodings:** `utf8`/`utf-8`, `utf16le`/`ucs2`, `latin1`/`binary`, `ascii`, `hex`, `base64`, `base64url` (with Node's lenient base64 normalization and `ascii` high-bit masking).
- **Errors:** Node `err.code`s and message shapes for `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, `ERR_BUFFER_OUT_OF_BOUNDS`, `ERR_UNKNOWN_ENCODING`, `ERR_INVALID_BUFFER_SIZE`.
- **Rendering:** `util.inspect`/`console.log` emit `<Buffer ..>` (honoring `INSPECT_MAX_BYTES`) via the `nodejs.util.inspect.custom` hook.
- **Module extras:** `Blob`, `File`, `SlowBuffer`, `atob`/`btoa`, `isAscii`, `isUtf8`, `transcode`, `resolveObjectURL`, `kMaxLength`/`kStringMaxLength`/`constants`/`INSPECT_MAX_BYTES`.

**Intentional differences / deferred:**

- `Buffer.poolSize` allocation pooling is modeled like Node: a per-runtime pool `ArrayBuffer` of `Buffer.poolSize` (8192) bytes serves small *unsafe* allocations — `Buffer.allocUnsafe(size)`, the `Buffer.from(string|array|typed-array)` copy paths, and `Buffer.concat` — when `size < (Buffer.poolSize >>> 1)` (Node's threshold is strictly less-than, so exactly `poolSize/2` is *not* pooled), advancing an 8-byte-aligned offset and re-pooling on exhaustion. Such buffers share one backing store at different `byteOffset`s, and `buf.buffer.byteLength` is the pool size rather than the buffer length. `Buffer.alloc` (zero-filled), `Buffer.allocUnsafeSlow`, `SlowBuffer`, and large allocations keep their own right-sized backing store, as in Node. `Buffer.concat` zero-fills any tail an explicit `totalLength` leaves uncovered, so a pooled result never exposes stale pool bytes. The pool is plain per-runtime module state, so it never leaks across isolated runtimes. Pool *offsets* are not byte-for-byte identical to Node's because Node pre-warms its pool with internal startup allocations; only the relative pooling semantics match, and well-behaved packages must not depend on pool identity anyway.
- `Buffer.poolSize` is a plain data property that stores and returns the raw assigned value (no coercion on read), and the pool's backing store is sized straight from it — matching Node's `new Uint8Array(Buffer.poolSize)`. A fractional `poolSize` is truncated (`8192.7` → `8192`), and a negative or non-finite `poolSize` throws a catchable `RangeError` on the next (re-)pool, rather than the previous `>>> 0`, which wrapped a negative `poolSize` into a multi-gigabyte request and a `>= 2^32` one into a mod-2^32 size (issue #213). A failed re-pool leaves the existing pool intact (the new backing store is committed only on success), so the throw is recoverable. One benign divergence remains: for a `poolSize` large enough to exceed JavaScriptCore's typed-array allocation cap (a few GiB), the (re-)pool throws `RangeError` where Node (whose limit is ~`2^53`) would instead build a multi-gigabyte pool. That is reachable only by deliberately setting `poolSize` to gigabytes *and* forcing a re-pool, and throwing is the safer behavior — Lava never attempts the giant allocation. Setting `Buffer.poolSize` to any such value is itself unrealistic (the default is 8192 and the threshold still uses Node's `>>> 1` verbatim), so this only hardens the defensive path.
- `Buffer.allocUnsafe` (above the pool threshold), `Buffer.allocUnsafeSlow`, and `SlowBuffer` return genuinely **uninitialized** memory like Node: a native allocation (`pkg/runtime/typed_array.odin`) hands JavaScriptCore a non-zero-filled backing store as a NoCopy `Uint8Array`, which the JS layer wraps as a Buffer view. A JS `new ArrayBuffer` is always zero-initialized, so this cannot be done in pure JS; that was the prior divergence (large unsafe allocations came back zero-filled). Such buffers now hold arbitrary prior memory contents — reading a byte before writing it is undefined behavior, as in Node. `Buffer.alloc` remains zero-filled, and the `Buffer.from`/`Buffer.concat` copy paths always overwrite (or zero-fill) every byte, so they never expose stale memory (issue #212). As a safety bound the native uninitialized path serves single allocations up to `2^31 - 1` bytes; a larger unsafe request falls back to a zero-filled own-backing store (JavaScriptCore's NoCopy creator aborts the process past an internal multi-gigabyte limit, whereas the JS allocation throws a catchable `RangeError`). The cap is far above any realistic `allocUnsafe` and keeps behavior identical across Linux, macOS, and Windows.
- The advertised `kMaxLength` matches Node (`Number.MAX_SAFE_INTEGER`); the *practical* ceiling is available memory. An in-range size the engine cannot satisfy throws a catchable `RangeError` (`Out of memory`); the unsafe native-allocation path is additionally capped (above) so it never drives JavaScriptCore's NoCopy allocator into a process abort. Negative/`NaN`/non-number sizes are validated and throw before any allocation.
- Property-access `TypeError` messages for engine-level faults (e.g. reading a property of `undefined`) carry JavaScriptCore wording, not V8's.

## `process` surface

**Present:** `argv`, `env`, `cwd()`, `exit()`, `nextTick()`, `pid`, `platform`, `arch`, `version`, `versions`.

**Missing:** `hrtime`/`hrtime.bigint`, `chdir`, `kill`, `memoryUsage`, `resourceUsage`, `uptime`, `stdout`/`stderr`/`stdin`, `execPath`, `argv0`, `execArgv`, `umask`, EventEmitter methods (`on`/`once` for `exit`/`uncaughtException`/signals), `process.exitCode`, `process.title`, `process.report`, `process.hrtime`.

## N/A pages (not a JS-API surface)

`addons`, `n-api`, `embedding` (native add-on / C API), `cli`, `debugger`, `single-executable-applications` (tooling — lava CLI is `eval`/`run` only), `deprecations`, `documentation`, `errors`, `index`, `synopsis`, `typescript` (conceptual / catalogs). `environment_variables` is partly honored.

## Biggest gaps by impact

1. **Networking stack** — `net`/`tls`/`http`/`https`/`http2`/`dgram`. fetch covers outbound HTTP(S) client only; there is no server or raw-socket capability.
2. **Streams** — Web Streams (`node:stream/web`) now ship (see above); the classic object-mode `node:stream` (`Readable`/`Writable`/`Duplex`/`Transform`, `pipeline`/`finished`) and `node:stream` ↔ Web Stream bridging remain, blocking fs streams, classic http bodies, and zlib piping.
3. **`util` helpers** — `promisify`/`callbackify`/`types`/`inherits` are load-bearing for many packages.
4. **`os`**, **`zlib`**, **`querystring`**, **`string_decoder`** — small, high-frequency modules that are cheap wins.
5. **`crypto` asymmetric/cipher** — hashing/HMAC/KDFs (incl. scrypt) and digest aliases are real; the asymmetric/cipher surface (keys, sign/verify, ciphers, ECDH/DH, X.509, argon2, subtle) is still stubbed and needs OpenSSL wiring (TLS already links it).
6. **`dns`** — public module (in progress; c-ares planned).
7. **Concurrency** — `worker_threads`/`child_process` entirely absent.
