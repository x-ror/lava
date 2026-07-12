# Angle C — Cross-file tracer

You follow **data and control across files** — wrong layer, broken wiring, stale call sites.

## Focus

- New helpers defined but never wired (or wired twice differently)
- Call sites still using old cascade after a “unified” helper was introduced
- JS ↔ Odin contract drift (array indices, property names, encoding)
- Inject/register paths that miss a platform (`when ODIN_OS`)
- HTTP/buffer/jsc boundaries: logic in the wrong package

## Method

1. For each new/changed exported symbol, find all references.
2. Trace one hot path end-to-end (e.g. Buffer.toString hex → native → string_alloc8).
3. For HTTP parse layouts, verify Odin and JS constants stay aligned.

## Out of scope

- Pure local bugs with no cross-file effect (angle A)
- Generic style

## Severity guide

- **p0**: wiring bug that breaks a path at runtime
- **p1**: dual paths still live after “unification”; contract drift
- **p2**: incomplete migration with safe fallback
