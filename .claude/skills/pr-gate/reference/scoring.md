# Scorecard

Two ranked criteria decide whether the change is *good*. Six gates decide whether
it is *mergeable*. A change can be fast and still not merge.

## Ranked criteria

### 1. Node interface conformance (primary)

| Grade | Meaning |
| ----- | ------- |
| A | Verified against real Node on every surface the diff touches; no divergence. |
| B | Verified; divergences exist and every one is intentional, commented, declared in the PR, and pinned by a Lava-only test. |
| C | Plausible parity, not verified empirically (no oracle run, no `bin/lava` diff). |
| F | Undeclared divergence on a user-visible surface, or a wrong error `code`/type/order on a common path. |

`F` blocks the merge. `C` blocks a PR that claims parity.

Deviation is legitimate **only** for measured speed or memory control — and then
the trade must be written at the call site and in the PR body.

### 2. Speed and memory (secondary)

| Grade | Meaning |
| ----- | ------- |
| A | Measured improvement (bench/profile output in the PR), no parity cost. |
| B | Neutral, or a small measured cost taken deliberately to buy correctness/parity. |
| C | Direction plausible but unmeasured, on a path that is not hot. |
| F | Measured regression, or a perf claim with no number, or a pathological cost (unbounded allocation, O(n²) per request, leak). |

A perf claim without evidence is graded `F` on this axis regardless of how the
code reads.

## Merge gates

Each gate is pass / fail. Any fail with an open **P0** blocks.

| Gate | Owner agent | Fails when |
| ---- | ----------- | ---------- |
| Correctness | `regression-hunter` | Introduced defect, removed behavior, broken wiring. |
| Native safety | `odin-safety-auditor` | UAF, race, GC hazard, allocator mismatch, lying stub, false probe latch. |
| Security | `security-auditor` | Reachable memory corruption, verification bypass, single-peer DoS, pollution vector, path escape, secret disclosure. |
| Test coverage | `test-coverage-auditor` | New behavior or bug fix with no test; test deleted or gap widened without reason; smoke not wired into CI. |
| Code quality | `code-quality-auditor` | Duplicates an existing helper or SDK routine on a hot path; wrong layer; file past ~1k with no split; high incidental complexity with a clear delete path. |
| Documentation | `docs-auditor` | A repo document is now false; a lifetime/probe/deviation rule shipped unexplained. |

Reuse (`odin-sdk-scout`) is not a separate gate — it feeds Code quality: a
hand-rolled routine that `core:`/`vendor:`/an already-linked C library implements
is a Code-quality **P1** with the concrete deletion named.

## Severity

| Severity | Meaning | Action |
| -------- | ------- | ------ |
| **P0** | Correctness, safety, security, or an undeclared Node divergence. | Blocks merge. |
| **P1** | Structural or contract problem: duplicated helper on a hot path, wrong layer, unproven perf claim, missing test for the main path, a document made false. | Fix, or waive explicitly in the PR with a reason. |
| **P2** | Real improvement, not a blocker. | Optional in this PR. |
| **nit** | Style, wording. | Ignore unless free. |

## Verdict

```
SHIP        — no P0; P1s either fixed or explicitly waived
SHIP-AFTER  — P0 count is small and each has a concrete named fix
BLOCK       — P0 with no clear fix, or a mechanical gate is red
```

Report the verdict with the two criterion grades, the six gate results, and the
P0/P1 list. Never report SHIP while a mechanical gate (`make check`,
`make check-js`, `make test`, the routed smokes) is failing or was not run.

When the mechanical gates are **delegated** (`--review-only`, e.g. a CI job that
reviews alongside the build job), the ceiling is `SHIP-AFTER (review gates only)`
and the report must say where the mechanical results live. A review that never ran
`make check` cannot clear a change to merge on its own.
