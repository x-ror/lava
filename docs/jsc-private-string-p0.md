# P0: JSC string / TypedArray bridge (stock gtk)

Status: **landed on `perf/buffer`** — full P0 (8-bit create + 8-bit read) on stock
`javascriptcoregtk-6.0`, no vendored WebKit.

## Goal

Close the Node/Bun gap on Buffer codecs by removing:

1. UTF-8 re-scan when building pure-ASCII JS strings (hex/base64/latin1 encode).
2. The widen-to-UTF-16 copy when reading 8-bit strings (`GetCharactersPtr`).
3. Extra C API calls / wrong offset on TypedArray views (issue #68).

## Key fact: stock gtk exports the private C++ ABI

`nm -D libjavascriptcoregtk-6.0.so.1` (2.52.3) exports everything needed — the
earlier conclusion that this required bun-webkit was wrong:

| Symbol | Use |
|--------|-----|
| `WTF::StringImpl::createUninitialized(size_t, span<LChar>&)` | alloc 8-bit string storage, write codec output directly |
| `WTF::StringImpl::createUninitialized(size_t, span<char16_t>&)` | same, 16-bit |
| `OpaqueJSString::tryCreate(WTF::String&&)` | wrap the impl as a `JSStringRef` for the public C API |
| `JSC::JSFunction::create(VM&, …, NativeFunction, …)` | not yet used — host-call functions, the phase-3 call-floor lever |

## What is implemented

### `pkg/jsc/private_string.odin` — pure Odin, no C++ shim

- `string_alloc8(n)` / `string_alloc16(n)` — allocate the string's final storage,
  caller writes into it, then `JSValueMakeString`. One pass, no validation, no
  temp buffer. Callers must fill every element before any other JSC call (hash
  is computed lazily and cached).
- `string_chars8(str)` — borrow a read-only `[]byte` view of an 8-bit string's
  storage (Latin-1 code points). Replaces `GetCharactersPtr`, which widens the
  whole 8-bit string to a fresh UTF-16 buffer.
- Symbols resolved by `dlsym` at first use (missing symbol ⇒ permanent fallback
  to the public C API, binary still runs on any gtk). ABI assumptions (sret
  returns, span layout) verified by an 8/16-bit round-trip self-test; the read
  side additionally probes StringImplShape/OpaqueJSString offsets and derives
  the 8-bit flag bit by diffing two impls of known width — any mismatch disables
  only the affected path.

### Consumers

- Encode (bytes→string): hex, base64, base64url write digits straight into the
  result string; latin1/ascii and the utf8 all-ASCII case are a single copy;
  utf16le decode writes units into 16-bit storage. `js_string_value` /
  `js_string_from_bytes` (runtime-wide bridge, http headers, sqlite TEXT) take
  the same fast path for ASCII.
- Read (string→bytes): hex/base64 parse, latin1/utf16le/utf8 encode +
  `writeInto` variants, and utf8/base64 `byteLength` all consume `string_chars8`
  when the source is 8-bit; `js_string_ref_to_utf8_owned` (every JS→Odin string)
  reads 8-bit storage directly, expanding Latin-1 high bytes exactly.
- `Buffer.from(string)` (buffer.js) allocates once — pooled, like Node — and
  fills via `writeInto`, instead of encode-to-native-array + copy-into-pool.

### View: fewer C API calls, same correctness (#68)

`typed_array_view` uses `BytesPtr` + `ByteOffset` (+ type/length). On first non-zero
offset it probes whether `BytesPtr == ArrayBuffer base` (gtk bug) or `base+offset`
(fixed JSC) and caches the mode. Probed 2026-07-10 (2.52.3): **BytesPtr still
returns base**.

## Phase 3 (landed): host-call convention + direct cell reads

The per-call C-API boundary was the next floor and is also gone on the probed
path:

- **Host functions** (`pkg/jsc/host_function.odin`): buffer natives register via
  the exported `JSC::JSFunction::create(VM&, …, NativeFunction, …)` under a
  `JSLockHolder`, called as `EncodedJSValue fn(JSGlobalObject*, CallFrame*)` —
  no `JSCallbackFunction` trampoline and, critically, no per-call
  `JSLock::DropAllLocks`/re-lock. On 64-bit a JSValueRef IS the encoded value
  and JSContextRef IS the JSGlobalObject, so existing callback bodies are
  reused via a thin frame-slicing dispatch (`buffer_host.odin`). Validated by a
  functional probe (known args in, recognizable result out) with no NaN-boxing
  constants assumed. `LAVA_HOSTFN_DEBUG=1` reports probe outcomes.
- **Direct typed-array views** (`pkg/jsc/private_view.odin`): Uint8Array bytes
  read straight from the cell (type byte + probed `m_vector`/`m_length`
  offsets; byteOffset already folded into the pointer, which also sidesteps
  issue #68 entirely). Probed with three views over known backing stores.
- **Direct string-value reads** (`private_string.odin`): flat `JSString` cells
  resolve to their StringImpl via a probed fiber offset — `value_chars8/16`
  replace `JSValueToStringCopy` + widen on every decode-side native; ropes and
  non-strings fall back (the C API flattens).
- **Immediate int32s** (`pkg/jsc/private_value.odin`): argument/result numbers
  encode/decode against a tag derived from `JSValueMakeNumber`'s own output.
- **JS-side**: `Buffer.from(string)` fills a pooled allocation via `writeInto`;
  the allocUnsafe pool refills from the native uninitialized allocator (a
  `new Uint8Array(poolSize)` refill measured ~100µs on JSC — zeroing + GC-heap
  churn — vs plain malloc) with a 256 KiB slab; internal constructions use a
  bare `FastBuffer` subclass, skipping Buffer's argument dispatch.

## Measured (make bench, lava/node wall-time ratio, 1 KiB)

| bench | session start | after P0+reads | after phase 3 |
|-------|-------:|------:|------:|
| to-hex | 14.8x | 9.5x | ~9x |
| to-base64 | 18.5x | 12.5x | ~10x |
| to-latin1 | 35.8x | 10.9x | ~10x |
| to-utf16le | 28.5x | 12.1x | ~12x |
| to-utf8 | 6.2x | 5.5x | ~5x |
| from-latin1 | ~37x | 26.5x | **~6x** |
| from-utf16le | ~29x | 19.8x | **~8x** |
| from-utf8 | 5.3x | 4.3x | **~3x** |
| to-hex-tiny | 11.7x | 10.1x | ~8x |

Absolute per-op: `buf.write(str, 'latin1')` ≈ 190 ns end-to-end (was ~1.7 µs).

## Phase 4 (landed): SIMD codecs + host registration for every native

- Portable `core:simd` codecs: hex encode 16 B/step (branchless digit map, two
  interleave shuffles), hex decode validate+convert 16 chars → 8 B/step with
  exact scalar fallback at the first invalid lane, base64/base64url encode via
  Muła's u16-lane layout with per-lane vector shifts. utf16le decode/encode/
  writeInto are single memcpys on little-endian hosts. Full-range `toString`
  skips the subarray view (~300 ns/call).
- `inject_native_function` host-registers *all* natives: one generic trampoline
  keys dispatch on the frame's callee slot, functions are pinned + cached per
  (context, callback, name), and callback-set exceptions become real throws via
  the exported `JSC::VM::throwException`.

End state (lava/node): to-hex ~4.5x, to-base64 ~5x, to-hex-tiny 1.8x
(94 ns/op), to-latin1/to-utf16le ~5x, from-utf8 2.4x, from-latin1 ~11x.
HTTP hello 0.75x node req/s (was 0.60x), mem/conn 0.43x node.

## Remaining gap / follow-up

from-* is dominated by JSC's ArrayBuffer/typed-array construction (~3–30x
V8's), partially amortized by the larger native-backed pool; to-*'s residual is
StringImpl allocation + JSString cell + the ~100–200 ns dispatch floor. The
next perf axis is http per-core profiling — its natives, header strings and
write paths now all ride the host-call + 8-bit-string fast paths.

## Verify

```sh
make build && make bun-buffer-tests && make test-compat-lava
# offset view (issue #68)
bin/lava eval 'const p=Buffer.allocUnsafe(16); for(let i=0;i<16;i++)p[i]=i; console.log(p.subarray(8,12).toString("hex"))'
# expect: 08090a0b
make bench
```
