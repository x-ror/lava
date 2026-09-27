---
name: pr-gate
description: >
  Hard merge gate — mechanical tests + specialist review + SHIP/SHIP-AFTER/BLOCK.
  Required before any PR.
argument-hint: '[--local | --branch <name> | --pr <n>] [--quick | --review-only]'
---

# /pr-gate

Canonical playbook: [agents/prompts/pr-gate.md](../../../agents/prompts/pr-gate.md)
Gates: [agents/prompts/pr-gate-reference/gates.md](../../../agents/prompts/pr-gate-reference/gates.md)
Scoring: [agents/prompts/pr-gate-reference/scoring.md](../../../agents/prompts/pr-gate-reference/scoring.md)

## Hard rules

1. Mechanical gates first (`make check` / `make build` fail → **BLOCK**, no specialists).
2. Fan out specialists from `agents/specialists/` in parallel.
3. Never self-waive a P1 — SHIP-AFTER is the ceiling when one is open.
4. Autonomous ceiling is **SHIP-AFTER** when any P1 remains. Merge is always human.
5. Open a PR **only** after SHIP or SHIP-AFTER from this gate.
