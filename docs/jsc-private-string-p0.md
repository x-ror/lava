# P0: JSC string / TypedArray bridge (stock gtk)

Status: **partial on stock `javascriptcoregtk-6.0`** — landed on `perf/buffer`.

## Goal

Close the Node/Bun gap on Buffer codecs by removing:

1. UTF-8 re-scan when building pure-ASCII JS strings (hex/base64/latin1 encode).
2. Extra C API calls / wrong offset on TypedArray views (issue #68).

## What stock gtk exports

| Symbol | Notes |
|--------|--------|
| `JSStringCreateWithUTF8CString` | Public; validates UTF-8 (encode floor). |
| `JSStringCreateWithCharacters` | Public; copies UTF-16; may 8-bit-compress. |
| `JSStringCreateWithCharactersNoCopy` | **Private** (`JSStringRefPrivate.h`); **no freer** — buffer must outlive the string (static/immortal only). |
| `JSObjectGetTypedArrayBytesPtr` | Still returns **ArrayBuffer base**, ignores `byteOffset` (probed 2026-07-10 on 2.52.3). |

True “adopt 8-bit buffer with freer” needs `WTF::ExternalStringImpl` / `StringImpl::createUninitialized` (C++ ABI, no headers in distro packages). That is the **bun-webkit / private WebKit** path, not stock gtk.

## What we implemented

### View: fewer C API calls, same correctness (#68)

`typed_array_view` uses `BytesPtr` + `ByteOffset` (+ type/length). On first non-zero
offset it probes whether `BytesPtr == ArrayBuffer base` (gtk bug) or `base+offset`
(fixed JSC) and caches the mode. Avoids `GetTypedArrayBuffer` +
`GetArrayBufferBytesPtr` on every subsequent call.

Probed 2026-07-10 (javascriptcoregtk 2.52.3): **BytesPtr still returns base**
(`BytesPtr[0]==0` for a view at offset 8).

### Encode: still UTF-8 CString on stock gtk

Tried writing UTF-16 + `JSStringCreateWithCharacters` for hex/base64; **regressed**
microbenches (~15× → ~28× Node) — widening every digit costs more than gtk’s
UTF-8 path for pure ASCII. Encode stays on `CreateWithUTF8CString`.

### Bound private API

`JSStringCreateWithCharactersNoCopy` declared on all platforms (exported by gtk).
**Not used for dynamic encode** (no freer → UAF if we free the buffer).

## Follow-up (full P0 / Node parity)

Optional C++ shim (like Windows `jsc_init`) with WebKit headers or vendored bun-webkit:

1. **`StringImpl::createUninitialized(len, LChar&)`** — write hex/base64 digits
   straight into JSC’s 8-bit buffer → `OpaqueJSString` (no UTF-8 scan, no UTF-16 widen).
2. **`ExternalStringImpl::create(LChar span, free_fn)`** — adopt our allocator buffer.
3. Gate with runtime probe / `when` so distro gtk keeps working.

Until then, codec microbench ratios remain dominated by the public C-API string floor.

## Verify

```sh
make build && make bun-buffer-tests
# offset view (issue #68)
bin/lava eval 'const p=Buffer.allocUnsafe(16); for(let i=0;i<16;i++)p[i]=i; console.log(p.subarray(8,12).toString("hex"))'
# expect: 08090a0b
make bench
```
