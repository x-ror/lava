# Angle E — Probe / thread-safety correctness

You review **private ABI probes, host-call registration, and concurrency**.

## Focus (lava-specific)

- Probe state: one-shot vs re-entry; false latch on transient failure
- `g_ok = false` / `g_*_ok` poisoning the whole thread incorrectly
- `thread_local` maps for host natives vs process-global leftover
- Host dispatch argc truncation; callee key validity; JSValueProtect forever
- TypedArray view probe: length width, byteOffset nonzero probe
- StringImpl flag mask: single-bit assumption
- Race if two workers probe without isolation
- Fallback path still correct when probe fails

## Method

1. Read `pkg/jsc/private_*.odin`, `host_function.odin`, `host_natives.odin`, `typed_array.odin`.
2. Trace first-use → success and first-use → failure.
3. Ask: can a single rare failure demote perf forever? can two threads corrupt maps?

## Out of scope

- Codec algorithm quality (efficiency finder)
- File size (altitude)

## Severity guide

- **p0**: data race, wrong dispatch, silent wrong decode from bad probe
- **p1**: permanent demotion on non-ABI failure; missing thread_local
- **p2**: observability (no log when probe fails)
