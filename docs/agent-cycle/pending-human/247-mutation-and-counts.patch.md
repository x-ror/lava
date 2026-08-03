# Applied in FIX REVIEW (agent-cycle/247)

The F1 hard-block deferred these to a human path. FIX REVIEW on this worktree
applied both:

1. `scripts/agent-cycle/case-counts.json` — `tests/node-compat/cases.min` **68 → 69**
2. Four `tests/mutation-manifest.json` entries for `66-process-console-intrinsic`
   (process/console factory re-read + natives wiring for each)

## Round 2 — PR #341 review follow-up (STILL PENDING)

`scripts/agent-cycle/case-counts.json` was raised again, **69 → 70**, for the new
case `tests/node-compat/cases/67-process-console-deleted-global.js`. That part is
already in the branch.

`tests/mutation-manifest.json` is human-only (`protected-write`), so the two
entries below could not be applied and **must be added by a human before merge**.
Both were verified by hand on this worktree: mutate, `make build`, run the gate,
confirm red for the stated reason, restore, confirm green.

Insert after the `66-process-console-intrinsic dies when natives stop handing
console the intrinsic` entry:

```json
    {
      "name": "67-process-console-deleted-global dies when node:process re-reads the deleted global",
      "why": "Same source mutation as the 66 entry, aimed at a gate that fails DIFFERENTLY: with globalThis.process deleted before the first require, the free-var read is an undeclared identifier under 'use strict', so the factory dies with ReferenceError instead of exporting the wrong object. Recorded separately because 66 cannot reach that shape — its trailing delete runs after both modules are cached — and without an entry nothing would notice 67 going vacuous (a require creeping above the delete).",
      "source": "pkg/runtime/js/internal/process.js",
      "find": "  module.exports = intrinsic;",
      "replace": "  module.exports = process;",
      "gate": "compat:tests/node-compat/cases/67-process-console-deleted-global.js",
      "expect_detail": "ReferenceError"
    },
    {
      "name": "67-process-console-deleted-global dies when node:console re-reads the deleted global",
      "why": "Symmetric console half. It is not covered by the process entry above: that one dies at the first require and never reaches require('node:console'), so a console-only regression would pass the whole case.",
      "source": "pkg/runtime/js/internal/console.js",
      "find": "  module.exports = intrinsic;",
      "replace": "  module.exports = console;",
      "gate": "compat:tests/node-compat/cases/67-process-console-deleted-global.js",
      "expect_detail": "ReferenceError"
    },
```

Observed red output for both, on this worktree:

```text
ReferenceError: Can't find variable: process
ReferenceError: Can't find variable: console
```

`expect_detail` is the looser `ReferenceError` rather than the full JSC sentence
on purpose — the shape (a ReferenceError, not a wrong-object assertion) is what
distinguishes this gate from 66, and JSC's exact wording is not a contract.

This file is the paper trail of the handoff; safe to delete once the PR merges
and round 2 is applied.
