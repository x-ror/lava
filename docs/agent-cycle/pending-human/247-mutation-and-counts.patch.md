# Human-required follow-ups for #247

Agent F1 hard-blocks Edit/Write on these paths. Apply outside the agent harness
(or with hooks disabled), then re-enable hooks.

## 1. Raise case-count floor

`scripts/agent-cycle/case-counts.json` — `tests/node-compat/cases.min`: **68 → 69**
(we added `66-process-console-intrinsic.js`). Current floor still passes (69 ≥ 68).

## 2. Mutation entries

Append to `tests/mutation-manifest.json` `mutations` array (before the gate-integrity
block is fine):

```json
{
  "name": "66-process-console-intrinsic dies when node:process re-reads the global",
  "why": "The factory used to export the free-var process, so a pre-first-require reassignment of globalThis.process poisoned every later require('node:process'). Node returns the intrinsic regardless (#247).",
  "source": "pkg/runtime/js/internal/process.js",
  "find": "  module.exports = intrinsic;",
  "replace": "  module.exports = process;",
  "gate": "compat:tests/node-compat/cases/66-process-console-intrinsic.js",
  "expect_detail": "require(\"node:process\") must be the intrinsic"
},
{
  "name": "66-process-console-intrinsic dies when node:console re-reads the global",
  "why": "Same bug on the console factory: a pre-first-require reassignment of globalThis.console was captured as the module export. Console is a separate source file, so a single process entry would leave it unpinned.",
  "source": "pkg/runtime/js/internal/console.js",
  "find": "  module.exports = intrinsic;",
  "replace": "  module.exports = console;",
  "gate": "compat:tests/node-compat/cases/66-process-console-intrinsic.js",
  "expect_detail": "require(\"node:console\") must be the intrinsic"
},
{
  "name": "66-process-console-intrinsic dies when natives stop handing process the intrinsic",
  "why": "If install_internal_modules stops putting the process object on natives, the factory fail-closes. This pins the Odin wiring half, not just the JS export line.",
  "source": "pkg/runtime/globals.odin",
  "find": "\tif process_val := get_named(ctx, global, \"process\"); process_val != nil {\n\t\tset_named(ctx, natives, \"process\", process_val)\n\t}",
  "replace": "\tif false {\n\t\tif process_val := get_named(ctx, global, \"process\"); process_val != nil {\n\t\t\tset_named(ctx, natives, \"process\", process_val)\n\t\t}\n\t}",
  "gate": "compat:tests/node-compat/cases/66-process-console-intrinsic.js",
  "expect_detail": "node:process intrinsic missing at context init"
},
{
  "name": "66-process-console-intrinsic dies when natives stop handing console the intrinsic",
  "why": "Symmetric to the process natives entry: console is a separate set_named, and leaving only the process one green-washes a console wiring regression.",
  "source": "pkg/runtime/globals.odin",
  "find": "\tif console_val := get_named(ctx, global, \"console\"); console_val != nil {\n\t\tset_named(ctx, natives, \"console\", console_val)\n\t}",
  "replace": "\tif false {\n\t\tif console_val := get_named(ctx, global, \"console\"); console_val != nil {\n\t\t\tset_named(ctx, natives, \"console\", console_val)\n\t\t}\n\t}",
  "gate": "compat:tests/node-compat/cases/66-process-console-intrinsic.js",
  "expect_detail": "node:console intrinsic missing at context init"
}
```

Hand-verified (agent cycle): factory global-read mutation → assertion message;
natives process wiring removed → `node:process intrinsic missing at context init`
after fail-closed factories (before fail-closed: MODULE_NOT_FOUND).
