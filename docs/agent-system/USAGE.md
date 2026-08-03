# Agent system — how to run

## Quick start (autonomous)

From the repo root:

```bash
# Process one ready GitHub issue end-to-end
node commands/index.mjs run-pipeline --once --provider grok

# Explicit issues
node commands/index.mjs run-pipeline --issues 335,247 --provider grok

# Dry-run (worktrees + prompts, no LLM)
node commands/index.mjs run-pipeline --issues 335 --provider none --dry-run
```

Equivalent:

```bash
node workflows/cli.mjs run --once --provider grok
```

## Let the system start itself

```bash
# Poll ready issues (label agent-ready / lava-ready / lava-task block)
node workflows/triggers/issues.mjs --once

# Scheduled drain (wire to cron every 30m)
node workflows/triggers/schedule.mjs --max 3 --provider grok

# PR comment contains /pr-gate
node workflows/triggers/pr-comments.mjs --comment-body '/pr-gate' --pr 42

# After gates fail in a worktree
node workflows/triggers/gate-failure.mjs --cwd "$LAVA_WORKTREE" --log gates.log
```

## Manual slash / single-agent

```bash
node commands/index.mjs list
node commands/index.mjs providers

node commands/index.mjs odin-feature --issue 335 --provider grok --worktree
node commands/index.mjs critic --cwd "$LAVA_WORKTREE" --provider claude
node commands/index.mjs pr-gate --cwd "$LAVA_WORKTREE" --provider grok
node commands/index.mjs fixer --cwd "$LAVA_WORKTREE" --provider grok
node commands/index.mjs planner --issue 335 --provider none --dry-run
```

In Claude Code / Grok Build TUI the same names are slash commands:
`/odin-feature`, `/pr-gate`, `/planner`, `/critic`, `/fixer`, `/run-pipeline`.

## Per-issue flow

1. **Select** ready issue (priority from `lava-task`, skip human-only).
2. **Worktree** outside main tree (`runtime/worktree-bootstrap.sh`).
3. **planner** → task DAG.
4. **odin-feature** → implement (TDD).
5. **critic** → adversarial findings.
6. **pr-gate** → mechanical gates + specialists → SHIP / SHIP-AFTER / BLOCK.
7. On BLOCK → **fixer** (≤3) → back to pr-gate.
8. On SHIP / SHIP-AFTER → **draft PR** (`gh pr create --draft`).
9. Human merges.

## State & logs

| Path                                  | Content                             |
| ------------------------------------- | ----------------------------------- |
| `.agent-state/last-run.json`          | Last pipeline summary               |
| `.agent-state/runs/<id>/state.json`   | Durable DAG state (resume)          |
| `.agent-state/runs/<id>/events.jsonl` | Step audit                          |
| `.agent-state/invoke-*.json`          | Per-command invoke audit            |
| `<worktree>/.agent-prompt.txt`        | Last prompt sent to the LLM         |
| `<worktree>/.agent-env`               | Ports / `LAVA_BIN` for the worktree |

## Requirements

- `gh` authenticated
- `grok` and/or `claude` and/or `codex` on PATH (or `--provider none`)
- Project hooks trusted (gate integrity)
- Push rights for draft PRs

## Parallelism

One pipeline process is sequential. For parallel issues, run disjoint queues in
separate terminals (avoid shared hot files: `loader.js`, eventloop, require).
