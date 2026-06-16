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
| 🟡 Partial | 14 | console, crypto, esm, fs, globals, module/modules, packages, perf_hooks, process, timers, util, webcrypto, environment_variables |
| 🟥 Missing | 39 | net, http(s), http2, stream, dns, dgram, tls, os, zlib, child_process, worker_threads, querystring, string_decoder, async_hooks, readline, repl, vm, v8, test, webstreams, … |
| ⚪ N/A | 10 | addons, cli, debugger, deprecations, documentation, embedding, errors, index, n-api, synopsis |

\* `intl` is provided by the JavaScriptCore engine, not by lava code.

## Requireable modules

| Module | `node:` | Status | Implemented | Key gaps | Source |
|--------|:------:|:------:|-------------|----------|--------|
| **assert** | ✅ | ✅ | ok/equal/strict*/deep*/match/throws/rejects/ifError + `assert/strict` (19 exports), `AssertionError` | snapshot/`partialDeepStrictEqual` niceties | [js/internal/assert.js](../pkg/runtime/js/internal/assert.js) |
| **buffer** | ✅ | ✅ | `Buffer` (full read/write/encode/search, Node-coded errors, `util.inspect` `<Buffer ..>`), `Blob`, `File`, `SlowBuffer`, `atob`/`btoa` (module-scoped), `isAscii`/`isUtf8`, `transcode`, `resolveObjectURL` (+ global `URL.createObjectURL`/`revokeObjectURL`) | `Buffer.poolSize` semantics; huge (>~RAM) allocations may abort under JSC rather than throw — see notes | [buffer.odin](../pkg/runtime/buffer.odin), [js/internal/buffer.js](../pkg/runtime/js/internal/buffer.js) |
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
| **http** | ❌ | 🟥 | — | `request`, `createServer`, `Agent` (fetch covers client GET/POST) | — |
| **https** | ❌ | 🟥 | — | same as http over TLS | — |
| **http2** | ❌ | 🟥 | — | entire module | — |
| **stream** | ❌ | 🟥 | — | Readable/Writable/Duplex/Transform, `pipeline`, `finished` | — |
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
| **webstreams** | ❌ | 🟥 | — | `ReadableStream`/`WritableStream`/`TransformStream` (also missing as globals) | — |
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

**Present (30):** `global`, `globalThis`, `Buffer`, `fetch`, `Headers`, `Request`, `Response`, `TextEncoder`, `TextDecoder`, `AbortController`, `AbortSignal`, `structuredClone`, `queueMicrotask`, `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`, `console`, `process`, `performance`, `Blob`, `File`, `crypto` (getRandomValues/randomUUID), `URL` (full WHATWG constructor + `createObjectURL`/`revokeObjectURL`), `URLSearchParams`, plus engine-provided `WebAssembly` and `Intl`.

**Missing:** `atob`, `btoa` (global form), `Event`, `EventTarget`, `CustomEvent`, `ReadableStream`/`WritableStream`/`TransformStream`, `TextEncoderStream`/`TextDecoderStream`, `CompressionStream`, `MessageChannel`/`MessagePort`, `Worker`, `BroadcastChannel`, `navigator`, `reportError`, `crypto.subtle`.

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

- `Buffer.poolSize` exists but allocation pooling is not modeled (`allocUnsafe` simply allocates); observable only via shared-`ArrayBuffer` identity of small buffers, which real packages should not rely on.
- The advertised `kMaxLength` matches Node (`Number.MAX_SAFE_INTEGER`); the *practical* ceiling is available memory. A huge but in-range allocation that exhausts memory aborts under JavaScriptCore rather than throwing a catchable `RangeError` as V8 does. Negative/`NaN`/non-number sizes are validated and throw before any allocation.
- Property-access `TypeError` messages for engine-level faults (e.g. reading a property of `undefined`) carry JavaScriptCore wording, not V8's.

## `process` surface

**Present:** `argv`, `env`, `cwd()`, `exit()`, `nextTick()`, `pid`, `platform`, `arch`, `version`, `versions`.

**Missing:** `hrtime`/`hrtime.bigint`, `chdir`, `kill`, `memoryUsage`, `resourceUsage`, `uptime`, `stdout`/`stderr`/`stdin`, `execPath`, `argv0`, `execArgv`, `umask`, EventEmitter methods (`on`/`once` for `exit`/`uncaughtException`/signals), `process.exitCode`, `process.title`, `process.report`, `process.hrtime`.

## N/A pages (not a JS-API surface)

`addons`, `n-api`, `embedding` (native add-on / C API), `cli`, `debugger`, `single-executable-applications` (tooling — lava CLI is `eval`/`run` only), `deprecations`, `documentation`, `errors`, `index`, `synopsis`, `typescript` (conceptual / catalogs). `environment_variables` is partly honored.

## Biggest gaps by impact

1. **Networking stack** — `net`/`tls`/`http`/`https`/`http2`/`dgram`. fetch covers outbound HTTP(S) client only; there is no server or raw-socket capability.
2. **Streams** — `stream` + `webstreams`. Blocks a huge swath of the ecosystem (fs streams, http bodies, zlib piping).
3. **`util` helpers** — `promisify`/`callbackify`/`types`/`inherits` are load-bearing for many packages.
4. **`os`**, **`zlib`**, **`querystring`**, **`string_decoder`** — small, high-frequency modules that are cheap wins.
5. **`crypto` asymmetric/cipher** — hashing/HMAC/KDFs (incl. scrypt) and digest aliases are real; the asymmetric/cipher surface (keys, sign/verify, ciphers, ECDH/DH, X.509, argon2, subtle) is still stubbed and needs OpenSSL wiring (TLS already links it).
6. **`dns`** — public module (in progress; c-ares planned).
7. **Concurrency** — `worker_threads`/`child_process` entirely absent.
