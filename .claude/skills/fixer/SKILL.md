---
name: fixer
description: >
  Fix code from pr-gate findings or red gate logs.
argument-hint: '[--issue N] [--cwd worktree]'
---

# /fixer

Playbook: [agents/prompts/fixer.md](../../../agents/prompts/fixer.md)

Address all open P0/P1. Re-run failed gates. Do not waive P1. Do not expand scope.
