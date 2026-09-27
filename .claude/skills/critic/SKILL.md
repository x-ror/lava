---
name: critic
description: >
  Adversarial critique of an implementation before pr-gate (debate quality).
argument-hint: '[--issue N] [--cwd worktree]'
---

# /critic

Playbook: [agents/prompts/critic.md](../../../agents/prompts/critic.md)

Report findings as the playbook's JSON — to the file the human names, else
inline. Do not fix code; do not open PRs.
Pipeline order: odin-feature → **critic** → pr-gate.
