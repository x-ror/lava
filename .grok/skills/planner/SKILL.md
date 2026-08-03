---
name: planner
description: >
  Analyze GitHub issues and build a dependency DAG of implementable tasks.
  Human slash command AND system command (pipeline entry after select).
argument-hint: '[--issue N | --issues a,b]'
---

# /planner

```bash
node commands/index.mjs planner --issue <N> --provider auto
```

Playbook: [agents/prompts/planner.md](../../../agents/prompts/planner.md)

Output a JSON task DAG. Mark human-only work. Do not implement features.
The autonomous pipeline runs planner before odin-feature on every new task.
