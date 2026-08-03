# Moved: autonomous agent system

The F1–F7 “agent-cycle” integration plan and the `scripts/agent-cycle/` driver
have been **fully replaced**.

Canonical docs:

- [docs/agent-system/ARCHITECTURE.md](agent-system/ARCHITECTURE.md)
- [docs/agent-system/USAGE.md](agent-system/USAGE.md)
- [config/agents.yaml](../config/agents.yaml)
- [config/pipeline.json](../config/pipeline.json)

Entry points:

```bash
node commands/index.mjs run-pipeline --once --provider grok
node workflows/cli.mjs run --once
node workflows/triggers/issues.mjs --once
```

Slash commands (human **and** system): `/odin-feature`, `/pr-gate`, `/planner`,
`/critic`, `/fixer`, `/run-pipeline`.
