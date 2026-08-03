# Lava agent system — architecture

Autonomous agent platform for implementing Lava itself. Humans and the system
share **one** command layer: named commands (`odin-feature`, `pr-gate`, …) are
both slash-commands and machine-callable entry points.

```text
┌─────────────────────────────────────────────────────────────────┐
│  Trigger Layer                                                   │
│  issues · labels · schedule · PR comments · gate failure · CLI   │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Command & Agent Layer   node commands/index.mjs <cmd>           │
│  /odin-feature  /pr-gate  /planner  /critic  /fixer  /run-pipeline│
└────────────────────────────┬────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Agent Registry          config/agents.yaml + config/agents.json │
│  role · prompt · tools · provider · retry · isolation            │
└──────────────┬─────────────────────────────┬────────────────────┘
               ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────────────┐
│  LLM Router  llm/        │   │  Workflow Engine  workflows/     │
│  grok · claude · codex   │   │  LangGraph-style DAG + durable   │
│  dual-review support     │   │  Temporal-like state in          │
└──────────────────────────┘   │  .agent-state/runs/              │
                               └──────────────┬───────────────────┘
                                              ▼
                               ┌──────────────────────────────────┐
                               │  Runtime  runtime/                │
                               │  worktree isolation · gates · gh  │
                               └──────────────────────────────────┘
```

## Layers

| Layer    | Path                          | Responsibility                                                          |
| -------- | ----------------------------- | ----------------------------------------------------------------------- |
| Trigger  | `workflows/triggers/`         | Start work without a human: issues, schedule, PR comments, gate failure |
| Command  | `commands/`                   | Single invoke path for humans and system                                |
| Registry | `agents/` + `config/agents.*` | Agent definitions and prompts                                           |
| LLM      | `llm/`                        | Provider routing (Grok / Claude / Codex / none)                         |
| Workflow | `workflows/`                  | DAG graph runner + durable state                                        |
| Runtime  | `runtime/`                    | Worktrees, gate integrity, routing, GitHub API                          |

> Note: `runtime/` here is the **agent** isolation layer. The Lava JS runtime
> remains `pkg/runtime/`.

## Default pipeline DAG

```text
select → planner → odin-feature → critic → gates → pr-gate ─┬→ create-pr → done
                              ▲                      │
                              └──── fixer (≤3) ──────┘  (on BLOCK / red gates)
```

Rules:

1. Every agent step calls `invokeCommand(name)` — no side channel.
2. Each task runs in an isolated git worktree (`runtime/worktree-bootstrap.sh`).
3. Draft PR is created **only** after `pr-gate` returns SHIP or SHIP-AFTER.
4. Merge to `master` is **never** automatic.
5. P1 findings are not self-waived.

### Where the task DAG comes from

Nothing authors it. The graph is **derived** from the tracker by
`runtime/dag.mjs`:

| Signal in the tracker                   | Meaning in the DAG                    |
| --------------------------------------- | ------------------------------------- |
| `### Tier N` in the master queue issue  | priority — lower tier drains first    |
| `- [ ] #N` under a tier                 | queue membership                      |
| `- [x] #N`                              | done, even if the issue is still open |
| `- [ ] #N` in any epic                  | edge: the epic waits on that child    |
| `#A … (do before #B)`                   | edge: B waits on A                    |
| an edge pointing outside the open set   | dependency already satisfied          |
| `<!-- lava-task blocked-by: [...] -->`  | edge, still honoured where one exists |

Set `AGENT_QUEUE_ISSUE` to point at a different index issue.

The consequence worth stating: an epic with open children is blocked **by them**,
so epics never enter the implementable queue and the `epic` label needs no
special case. And because a closed issue simply drops out of the open set, the
graph shrinks as work lands with no checkbox bookkeeping — which is also why
`listOpenIssues` refuses a truncated page rather than returning it. A dropped
issue would not read as missing; it would read as *finished*, and unblock
everything waiting on it.

A second copy of this data — priority in issue bodies, or a backlog file — is the
thing to avoid. planner.md rule 1 says as much, and `planner` therefore
decomposes one issue into steps and does not author edges between issues.

**Ordering is derived; permission is not.** An issue is only drained once a human
labels it `agent-ready` (or `lava-ready`). The tracker states what the work is
worth; the label states that an agent may do it unattended.

```bash
node workflows/cli.mjs queue        # what would run now
node workflows/cli.mjs queue --all  # full derived order, ignoring the gate
```

### Planner output

`planner` writes `.agent-plan.json` into the worktree. `commands/invoke.mjs`
reads it back and renders it into the prompt of every later agent in the run, so
`acceptance` and `human_only` actually reach the agent implementing against them;
the engine copies it to `.agent-state/runs/<id>/plan.json`, which outlives the
worktree. A plan printed only to stdout is discarded.

### The gate fails closed

`pr-gate` reports through a file (`.agent-findings.json`), aggregated by
`runtime/gates/aggregate-verdict.mjs`. Only a machine-readable **SHIP** or
**SHIP-AFTER** advances to `create-pr`. Everything else — BLOCK, a crash, a
turn-limit exit, a provider auth failure, or a run under provider `none` — is
BLOCK and routes to `fixer`.

This is not defensive styling. An earlier version read "exited 0 but wrote no
findings file" as SHIP-AFTER, so any pr-gate that died early opened a draft PR
with zero mechanical gates run. The agent's claim of success is not evidence;
the findings file is. Pinned by `workflows/engine.test.mjs`.

The `gates` node exists for the same reason: `pr-gate` runs the mechanical gates
too, but that run is self-reported. The pipeline's own `runGates()` is the trust
boundary, and it is what sets `gateRed` for the aggregator — which turns a red
gate into BLOCK regardless of what the findings say. A stale findings file from a
previous fixer round is deleted before each hard-gate run, so a round cannot exit
on the previous round's verdict.

## Automatic start (system initiates)

| Trigger                                        | Entry                                                     |
| ---------------------------------------------- | --------------------------------------------------------- |
| Label `agent-ready` / `lava-ready` on an issue | `node workflows/triggers/issues.mjs`                      |
| New issue with `<!-- lava-task -->`            | same                                                      |
| Cron / systemd timer                           | `node workflows/triggers/schedule.mjs`                    |
| PR comment `/pr-gate` etc.                     | `node workflows/triggers/pr-comments.mjs`                 |
| Red mechanical gates                           | `node workflows/triggers/gate-failure.mjs`                |
| Human                                          | `/run-pipeline` or `node commands/index.mjs run-pipeline` |

## Manual start (human)

Slash commands in Claude Code / Grok Build:

- `/odin-feature` — implement
- `/pr-gate` — hard gate
- `/planner` — DAG
- `/critic` — debate
- `/fixer` — fix rounds
- `/run-pipeline` — full autonomous drain

Or CLI: `node commands/index.mjs <command> …`

## Gate integrity

Preserved from the prior system, relocated:

- `runtime/gates/integrity.mjs` — PreToolUse command filter
- `runtime/gates/assert-case-counts.mjs` + `case-counts.json`
- `runtime/gates/route-gates.mjs`
- `runtime/gates/aggregate-verdict.mjs`

Hooks: `.claude/hooks/gate-integrity.sh`, `.grok/hooks/gate-integrity.json`.

## Dual review

When `dual_review.enabled` is true in the registry, `critic` / review steps prefer
a different LLM provider than the implementer (writer ≠ checker).

## What was removed

The previous integration under `scripts/agent-cycle/`, `/agent-cycle` skill, and
the F1–F7 phase driver (`driver.mjs` / `run-loop.mjs` as the only automation
path) is fully deleted. Useful gate machinery was moved into `runtime/gates/`,
not hybridized.
