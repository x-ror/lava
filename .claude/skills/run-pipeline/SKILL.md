---
name: run-pipeline
description: >
  Run the full autonomous DAG: select → planner → odin-feature → critic → pr-gate
  → (fixer)* → draft PR. System self-start entry; humans can also invoke.
argument-hint: '[--once | --max N | --issues a,b | --provider grok|claude|codex|none]'
---

# /run-pipeline

```bash
# One ready issue
node commands/index.mjs run-pipeline --once --provider grok

# Explicit queue
node commands/index.mjs run-pipeline --issues 335,247 --provider grok

# Or via workflow CLI / triggers
node workflows/cli.mjs run --once --provider grok
node workflows/triggers/issues.mjs --once
node workflows/triggers/schedule.mjs --max 3
```

Architecture: [docs/agent-system/ARCHITECTURE.md](../../../docs/agent-system/ARCHITECTURE.md)  
Usage: [docs/agent-system/USAGE.md](../../../docs/agent-system/USAGE.md)

**Never merges.** Draft PR only after pr-gate SHIP / SHIP-AFTER.
