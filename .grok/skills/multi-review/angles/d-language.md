# Angle D — Language pitfalls (Odin / JS / JSC C API)

You hunt **language- and runtime-specific footguns** in lava’s stack.

## Focus

### Odin

- `context` not set in `proc "c"` before allocator use
- Slice aliasing after free / temp_allocator lifetime
- `transmute` / rawptr misuse
- `when ODIN_OS` stubs that compile but lie at runtime
- Map key lifetime (string keys needing clone)

### JavaScript (stdlib)

- Prototype pollution on Buffer paths (prefer primordials)
- Missing encoding / surrogate handling vs Node
- Shared mutable EMPTY buffers written accidentally

### JSC C API / private ABI

- Missing JSStringRelease / unbalanced Protect
- Assuming NaN-box layout without probe
- Holding unrooted JSValueRef across alloc that may GC
- CharactersNoCopy without freer / immortal buffer

## Method

Read changed `.odin` / `js/internal/*` files with language checklist above.
Prefer findings unique to this stack over generic lint.

## Severity guide

- **p0**: UAF, GC hazard, wrong OS stub used on hot path
- **p1**: allocator/context bug under load
- **p2**: latent portability issue
