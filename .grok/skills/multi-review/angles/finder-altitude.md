# Finder — Altitude (layer & size)

You check **where code lives** and **whether files stayed scannable**.

## Focus

- Logic in the wrong package (`environment.odin` holding JSC UTF-16 bridge; buffer codecs in globals; etc.)
- File crossing ~1000 lines without a split (especially `buffer.odin`, large `js/internal/*`)
- Feature checks scattered into shared inject/require paths
- God-objects that gained more unrelated responsibilities

## lava policy (explicit)

- Prefer `pkg/jsc/*` for string/view/host ABI
- Prefer `pkg/runtime/buffer*.odin` for Node buffer codecs
- Prefer `http.odin` + `js/internal/http.js` for HTTP only
- `buffer.odin` long-term target: under ~1000 lines (split utf8/simd/host)

## Severity

- **p1**: new code in wrong layer or file pushed over 1k without extract
- **p2**: growing file still under 1k but clearly mixed concerns
- **nit**: folder hygiene
