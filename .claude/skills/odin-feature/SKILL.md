---
name: odin-feature
description: Implementation pipeline for Lava runtime work — reuse scout over the Odin SDK and linked C libraries, Node-parity design, layered implementation, tests, and gates. Use when asked to add or change a Node API, a native primitive, an event-loop or I/O capability, or any performance work in `pkg/runtime`, `pkg/jsc`, or `pkg/runtime/js`.
argument-hint: '<what to build> [--no-scout] [--design-only]'
---

# Feature pipeline

Five phases. Do not skip phase 1 — writing low-level code that the Odin SDK or an
already-linked C library already implements is the failure mode this pipeline
exists to prevent.

Read `CLAUDE.md` first. Reuse index:
[reference/odin-sdk-map.md](reference/odin-sdk-map.md). Gate routing:
[../pr-gate/reference/gates.md](../pr-gate/reference/gates.md).

## Phase 1 — Node contract + reuse scout (parallel)

Launch both in one message:

**(a) The Node contract.** Determine exactly what Node does for the target API —
run `node` for real, and consult `reference/node-doc-api` and
`reference/node-compat.json` in-repo. Capture: exported shape, argument coercion
*order*, defaults, return types, thrown `code`/`name`/`message`, event and
callback ordering, and the edge cases (empty, `NaN`, `-0`, out-of-range,
`undefined` vs missing, detached buffers, lone surrogates). This is the spec you
implement against — not your memory of the docs.

**(b) `odin-sdk-scout`.** Ask for a use/wrap/reject verdict per capability the
feature needs, searching in-repo → `core:` → `vendor:` → already-linked C → new
dependency → hand-roll. Skip only with `--no-scout`, and only for a change that
writes no new low-level logic.

## Phase 2 — design

Write a short design (not a document — a message) covering:

- **Seam**: what is native (`pkg/runtime/*.odin`), what is embedded JS
  (`js/internal/*.js`), what crosses the `native` bindings argument, and why. Hot
  or unsafe → native; ergonomic spec surface → JS. Wrong-layer code is rejected in
  review even when it works.
- **Reuse decisions** from the scout: what you will call instead of write, and for
  each rejection, the evidence.
- **Ownership**: who allocates, under which allocator, who frees, when. Anything
  crossing a loop turn or a `proc "c"` boundary needs this pinned before coding.
- **Blocking**: anything that can block goes off-loop via `pool_submit`, with the
  completion re-queued so Node's phase ordering survives.
- **Platforms**: the Linux implementation plus honest stubs for windows/darwin
  (`make check` cross-checks both front ends).
- **Deviation from Node**, if any: what it buys, measured how, pinned by which test.
- **Tests**: which oracle cases, which Odin tests, which smoke.
- **Gates**: the commands the touched paths require.

Stop here with `--design-only`. Otherwise, for anything non-trivial, put the
design in front of the user before implementing.

## Phase 3 — implement

Use `odin-implementer` for scoped, independent pieces (they parallelize well:
native primitive / JS surface / tests), or implement directly for a small change.
Either way the conventions in `CLAUDE.md` §4–5 are binding: allocator capture,
JSC protect/release pairing, `-> bool` for C `_Bool`, primordials in JS, coded
errors, `when ODIN_OS` honesty, comments that explain why.

Order that avoids rework: native primitive → wire the binding → JS surface →
tests. Keep `make check` green as you go rather than at the end.

## Phase 4 — verify

1. `make fmt` (Odin), `make check`, `make check-js`, `make build`.
2. The routed suites and smokes from
   [../pr-gate/reference/gates.md](../pr-gate/reference/gates.md) — networking
   smokes run on **both** backends.
3. Node-vs-Lava diff on your own probe script for every surface you touched.
4. `make bench` if the change touches a hot path, and always for a `perf(...)`
   change. Record the numbers; a perf claim without them does not pass the gate.

Report actual output. A failing gate you cannot fix is stated plainly, not
described as done.

## Phase 5 — hand off

- Commit message: `type(scope): imperative summary`.
- PR body: what changed, reuse verdict, gates run with results, Node-parity
  evidence or the justified deviation, bench numbers if perf is claimed.
- Update the docs the change triggers (`docs-auditor`'s table lists them:
  ARCHITECTURE for a new seam, ROADMAP for a completed item, README for a new
  dependency, `make help` for a new target).
- Run `/pr-gate` before requesting review.
