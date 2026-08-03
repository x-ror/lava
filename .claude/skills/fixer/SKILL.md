---
name: fixer
description: >
  Fix code from pr-gate findings or red gate logs. Max rounds enforced by the engine.
  Human slash command AND system command (also triggered on gate failure).
argument-hint: '[--issue N] [--cwd worktree]'
---

# /fixer

```bash
node commands/index.mjs fixer --issue <N> --cwd <worktree> --provider auto
# or after gate failure:
node workflows/triggers/gate-failure.mjs --cwd <worktree> --log gates.log
```

Playbook: [agents/prompts/fixer.md](../../../agents/prompts/fixer.md)

Address all open P0/P1. Re-run failed gates. Do not waive P1. Do not expand scope.
