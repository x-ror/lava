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

## Measured (make bench, lava/node wall-time ratio, 1 KiB)

| bench | before | after |
|-------|-------:|------:|
| to-hex | 14.8x | ~9x |
| to-base64 | 18.5x | ~12x |
| to-latin1 | 35.8x | ~10x |
| to-utf16le | 28.5x | ~12x |
| to-utf8 | 6.2x | ~5x |
| from-latin1 | ~37x | ~27x |
| from-utf16le | ~29x | ~21x |
| from-utf8 | 5.3x | ~4x |

## Remaining floor / follow-up

The residual gap is the per-call boundary: C-API callback entry, argument
JSValueRef marshaling (`JSValueToNumber` per arg), `JSValueToStringCopy`,
typed-array view resolution — several hundred ns per call vs V8 fast-API's tens.
Phase 3 lever: register hot codecs via the exported
`JSC::JSFunction::create(VM&, …, NativeFunction, …)` (host-call convention,
`CallFrame*` directly, no JSValueRef boxing) — needs vendored headers for the
PtrTag'd `FunctionPtr` types. SIMD codecs (hex `pshufb`, Muła base64, simdutf
transcode) become visible only after that floor drops.

## Verify

```sh
make build && make bun-buffer-tests && make test-compat-lava
# offset view (issue #68)
bin/lava eval 'const p=Buffer.allocUnsafe(16); for(let i=0;i<16;i++)p[i]=i; console.log(p.subarray(8,12).toString("hex"))'
# expect: 08090a0b
make bench
```
