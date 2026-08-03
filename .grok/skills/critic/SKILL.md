---
name: critic
description: >
  Adversarial critique of an implementation before pr-gate (debate quality).
  Human slash command AND system command.
argument-hint: '[--issue N] [--cwd worktree]'
---

# /critic

```bash
node commands/index.mjs critic --issue <N> --cwd <worktree> --provider auto
```

Playbook: [agents/prompts/critic.md](../../../agents/prompts/critic.md)

Write findings to `.agent-findings-critic.json`. Do not fix code; do not open PRs.
Pipeline order: odin-feature → **critic** → pr-gate.
