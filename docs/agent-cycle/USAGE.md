# Agent-cycle: how to run the automation loop

End-to-end loop the orchestrator runs for you:

```text
select task → worktree → implement agent → gates → review → fix (≤3 rounds)
  → draft PR → open follow-up issues if P0/P1 remain → next task → …
```

Merge to `master` is **never** automatic.

---

## One command (recommended)

From the **repo root** (`lava/`):

```bash
# Process ready issues with Grok headless (auto-approve tools)
node scripts/agent-cycle/run-loop.mjs --agent grok --max 5

# Same via driver alias
node scripts/agent-cycle/driver.mjs run --agent grok --max 5
```

### You pick the first N, then it continues that list

```bash
node scripts/agent-cycle/run-loop.mjs \
  --issues 335,247,332 \
  --agent grok \
  --max 10
```

Order is exactly the order you pass. After those, it stops (does not re-query unless you omit `--issues`).

### Only one task then stop

```bash
node scripts/agent-cycle/run-loop.mjs --once --agent grok
# or
node scripts/agent-cycle/run-loop.mjs --issues 335 --once --agent grok
```

### Dry-run (worktrees + prompt files, no agent)

```bash
node scripts/agent-cycle/run-loop.mjs --issues 335,247 --agent none --dry-run
# Then open each worktree and run Claude/Grok yourself
```

### Claude Code as the agent

```bash
node scripts/agent-cycle/run-loop.mjs --agent claude --max 3
```

### Auto-detect agent

```bash
node scripts/agent-cycle/run-loop.mjs --agent auto
# prefers: grok if on PATH, else claude, else none (scaffold only)
```

---

## Flags

| Flag | Meaning |
| ------ | --------- |
| `--once` | One issue, then exit |
| `--max N` | Cap issues this run (default 20) |
| `--issues a,b,c` | Explicit queue (numbers) |
| `--agent grok\|claude\|none\|auto` | Who implements/reviews |
| `--dry-run` | Bootstrap + write prompt; no agent/PR |
| `--skip-review` | Implement + gates only |
| `--no-pr` | Do not `gh pr create --draft` |
| `--max-turns N` | Headless turn budget (default 100) |

Env: `AGENT_CYCLE_AGENT`, `AGENT_CYCLE_MAX_TURNS`.

Logs: `.agent-cycle/run-loop.log`, `.agent-cycle/last-run.json`.

### Looks hung?

After `spawning grok in …` the agent can run **10–40+ minutes** (build, tests,
many tool turns). Older run-loop versions buffered all output until exit, so the
terminal stayed quiet while the agent worked.

**How to check it is alive:**

```bash
ps aux | grep 'grok -p\|grok --prompt' | grep -v grep
# worktree should gain modified files:
git -C /home/tymch/lava-wt-agent-cycle-*-* status -sb
```

Current run-loop streams agent stdout/stderr live (`stdio: inherit`) and uses
`--prompt-file` so you see progress.

---

## What happens per issue

1. **Select** — lava-task priority / blocked-by, or your `--issues` list. Skips `human-only` / #336-like.
2. **Worktree** — `worktree-bootstrap.sh agent-cycle/<n>` outside the main tree, own ports/`LAVA_BIN`.
3. **Implement agent** — headless Grok/Claude in that cwd with agent-cycle rules.
4. **Gates** — `route-gates.mjs` on the diff; run targets (skips full `test-mutation` in-loop).
5. **Fix** — up to 3 rounds if gates red.
6. **Review agent** — writes `.agent-cycle-findings.json`; fix rounds for P0/P1.
7. **Draft PR** — `gh pr create --draft` (unless `--no-pr`).
8. **Leftover P0/P1** — new GitHub issues with `lava-task` (no silent waive).
9. **Next** issue in the queue.

---

## Parallel (several agents at once)

`run-loop` is **sequential** (one issue after another in one process).

For true parallelism, open **multiple terminals**, each with a **disjoint** issue list:

```bash
# terminal 1
node scripts/agent-cycle/run-loop.mjs --issues 335,247 --agent grok --max 2

# terminal 2  (different issues, no shared hot files)
node scripts/agent-cycle/run-loop.mjs --issues 332,252 --agent grok --max 2
```

Do not put two issues that both touch `loader.js` / `eventloop` on different parallel runs.

---

## Requirements

- `gh` authenticated (`gh auth status`)
- `grok` or `claude` on PATH for `--agent grok|claude`
- Project hooks trusted (gate-integrity PreToolUse)
- Clean enough git remote push rights for draft PRs

---

## Interactive alternative (no headless)

```bash
node scripts/agent-cycle/run-loop.mjs --issues 335 --agent none --dry-run
cd ../lava-wt-agent-cycle-335-*   # path from log
source .agent-cycle-env
# open Grok/Claude TUI here, paste .agent-cycle-prompt.txt
```

Or in TUI from main repo:

```text
/agent-cycle
Implement #335 per docs/agent-cycle-plan.md …
```

---

## Stop conditions

| Condition | Behavior |
| ----------- | ---------- |
| Queue empty | exit 0 |
| `--max` reached | stop |
| Gates red after 3 fixes | mark needs-human, continue next |
| Human-only issue | skip |
| Agent binary missing + auto | scaffold as `none` |

You always merge draft PRs yourself.
