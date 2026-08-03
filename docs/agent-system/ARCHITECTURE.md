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
select → planner → odin-feature → critic → pr-gate ─┬→ create-pr → done
                              ▲              │
                              └── fixer (≤3)─┘  (on BLOCK / red gates)
```

Rules:

1. Every agent step calls `invokeCommand(name)` — no side channel.
2. Each task runs in an isolated git worktree (`runtime/worktree-bootstrap.sh`).
3. Draft PR is created **only** after `pr-gate` returns SHIP or SHIP-AFTER.
4. Merge to `master` is **never** automatic.
5. P1 findings are not self-waived.

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
