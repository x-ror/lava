---
name: odin-feature
description: >
  Implementation pipeline for Lava runtime work — reuse scout, Node-parity design,
  TDD, gates.
argument-hint: '<what to build> [--no-scout] [--design-only] [--issue N]'
---

# /odin-feature

**Command layer:** this skill is the human interface. The system invokes the same
agent via:

Canonical playbook: [agents/prompts/odin-feature.md](../../../agents/prompts/odin-feature.md)
SDK map: [agents/prompts/odin-feature-reference/odin-sdk-map.md](../../../agents/prompts/odin-feature-reference/odin-sdk-map.md)
Registry: [config/agents.yaml](../../../config/agents.yaml)

## When you run interactively

Follow the playbook in `agents/prompts/odin-feature.md` (five phases: scout →
design → red tests → implement → verify). Do not skip the reuse scout.

## After implement

Hand off to `/critic` then `/pr-gate`. PR is created only after pr-gate succeeds.
