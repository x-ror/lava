---
name: critic
description: >
  Adversarial critique of an implementation before pr-gate (debate quality).
argument-hint: '[--issue N] [--cwd worktree]'
---

# /critic

Playbook: [agents/prompts/critic.md](../../../agents/prompts/critic.md)

Report findings inline. Do not fix code; do not open PRs.
Pipeline order: odin-feature → **critic** → pr-gate.
