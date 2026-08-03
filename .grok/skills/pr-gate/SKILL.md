---
name: pr-gate
description: >
  Hard merge gate — mechanical tests + specialist review + SHIP/SHIP-AFTER/BLOCK.
  Required before any PR. Human slash command AND system command.
argument-hint: '[--local | --branch <name> | --pr <n>] [--quick | --review-only]'
---

# /pr-gate

**Command layer:**

```bash
node commands/index.mjs pr-gate [--issue N] [--cwd <worktree>] --provider auto
```

Canonical playbook: [agents/prompts/pr-gate.md](../../../agents/prompts/pr-gate.md)  
Gates: [agents/prompts/pr-gate-reference/gates.md](../../../agents/prompts/pr-gate-reference/gates.md)  
Scoring: [agents/prompts/pr-gate-reference/scoring.md](../../../agents/prompts/pr-gate-reference/scoring.md)

## Hard rules

1. Mechanical gates first (`make check` / `make build` fail → **BLOCK**, no specialists).
2. Fan out specialists from `agents/specialists/` in parallel.
3. Aggregate via `runtime/gates/aggregate-verdict.mjs` (no self-waive of P1).
4. Autonomous ceiling is **SHIP-AFTER** when any P1 remains. Merge is always human.
5. The pipeline opens a draft PR **only** after SHIP or SHIP-AFTER from this gate.

## System use

`workflows/pipeline.mjs` node `pr-gate` invokes this command automatically after
`critic`. On BLOCK → `fixer` (≤3 rounds) → re-enter `pr-gate`.
