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

## Filling the queue

The task DAG is not maintained separately — it is read out of the tracker
(tiers and `- [ ] #N` task lists; see
[ARCHITECTURE.md](ARCHITECTURE.md#where-the-task-dag-comes-from)). Look at it
before running anything:

```bash
node workflows/cli.mjs queue --all   # full derived order + what blocks what
node workflows/cli.mjs queue         # only what is cleared to run
```

`queue` is empty until issues carry `agent-ready`. That is the whole opt-in:

```bash
gh issue edit 91 --add-label agent-ready     # one issue
gh issue edit 348 355 357 --add-label agent-ready
```

Order and blocking then come from the tracker automatically — no `priority:` or
`blocked-by` needs writing into the issue body. To drain regardless of the label
(a deliberate override), `--issues` names them explicitly:

```bash
node commands/index.mjs run-pipeline --issues 91 --provider claude
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
6. **gates** → the pipeline runs the routed mechanical gates itself. Red → fixer.
7. **pr-gate** → specialists + verdict → SHIP / SHIP-AFTER / BLOCK.
8. On BLOCK → **fixer** (≤3) → back to gates.
9. On SHIP / SHIP-AFTER → **draft PR** (`gh pr create --draft`).
10. Human merges.

Anything other than SHIP / SHIP-AFTER is BLOCK, including a pr-gate that
produced no verdict at all. See "The gate fails closed" in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Retries

A trigger run records each issue in `.agent-state/trigger-issues-seen.json` with
its attempt count. A failed pipeline is retried on the next poll up to
`AGENT_TRIGGER_MAX_ATTEMPTS` (default 3); editing or re-labelling the issue
resets it to fresh work regardless of prior status. A completed issue is not
re-run.

A second run for one issue gets its own worktree and its own branch
(`agent/335`, then `agent/335-<pid>`), so a retry never collides with the
worktree or branch left by the previous attempt.

## State & logs

| Path                                    | Content                                |
| --------------------------------------- | -------------------------------------- |
| `.agent-state/last-run.json`            | Last pipeline summary                  |
| `.agent-state/runs/<id>/state.json`     | Durable DAG state (resume)             |
| `.agent-state/runs/<id>/events.jsonl`   | Step audit                             |
| `.agent-state/invoke-*.json`            | Per-command invoke audit               |
| `.agent-state/trigger-issues-seen.json` | Dispatch ledger (status, attempts)     |
| `<worktree>/.agent-prompt.txt`          | Last prompt sent to the LLM            |
| `<worktree>/.agent-env`                 | Ports / branch / `LAVA_BIN`            |
| `<worktree>/.agent-findings.json`       | Hard-gate verdict channel (gitignored) |

## Requirements

- `gh` authenticated
- `grok` and/or `claude` and/or `codex` on PATH (or `--provider none`)
- Project hooks trusted (gate integrity)
- Push rights for draft PRs

## Parallelism

One pipeline process is sequential. For parallel issues, run disjoint queues in
separate terminals (avoid shared hot files: `loader.js`, eventloop, require).
