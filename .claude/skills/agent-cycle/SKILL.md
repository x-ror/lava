---
name: agent-cycle
description: >
  Plan and execute Lava's autonomous agent-cycle integration (gate integrity,
  worktree safety, issue groom, gate routing, structured review I/O, driver,
  pilot). Use when asked to work on the agent loop, agent-cycle, drain backlog
  autonomously, PreToolUse gate hooks, or phases F1–F7 of docs/agent-cycle-plan.md.
  Also: /agent-cycle.
argument-hint: '[status | f1|f2|f3|f4|f5|f6|f7 | min-slice | pilot] [notes...]'
---

# Agent cycle

You orchestrate **integration of the autonomous agent cycle into this repo**.
You do not invent a parallel plan. Canonical document:

**[docs/agent-cycle-plan.md](../../../docs/agent-cycle-plan.md)**

Read it fully before any phase work. Both Claude Code and Grok Build share this
skill name and that plan file.

## Invocation

| Arg | Meaning |
| --- | --- |
| (empty) / `status` | Print phase table from the plan + git-relevant reality; stop |
| `f1` … `f7` | Implement or continue that phase only |
| `min-slice` | F1 + F2 + #337 only (manual cycle after); no F6 driver |
| `pilot` | F7 — only after F1+F2 done and bucket-(a) issues groomed enough |
| `groom` | Alias for `f3` |

If the user names an issue (`#337`) with this skill, treat it as pilot/task work
under F7 rules, not as a free-form feature.

## Hard rules (non-negotiable)

1. **Do not build F6 (driver) before F1 + F2 + F4 + F5 exist** unless the user
   explicitly overrides and accepts risk. Default path is the plan's graph.
2. **Source of truth for tasks = GitHub Issues.** Never create
   `.lava/backlog.yaml` or a second tracker. Structured state lives in the
   `<!-- lava-task ... -->` HTML comment + Acceptance checklist (see plan F3).
3. **Gate integrity over green CI.** Prefer a hard fail over a bypass. Do not
   widen `known-lava-gaps.txt`, raise primordials baselines, skip mutation
   entries, loosen `bench/thresholds.json` caps, or delete oracle/bench files
   to make a loop "succeed".
4. **Severity by defect class**, not diff size: Node parity, memory-safety,
   security, and gate-weakening are never P2. P2 = style / duplication / docs.
5. **Findings without `file:line` and without a concrete failure path** are not
   tasks — discard or mark as questions.
6. **Merge to master is always human.** Autonomous ceiling is SHIP-AFTER when
   any P1 remains (`pr-gate` scoring). Do not self-waive P1s.
7. **`odin-feature` in the loop:** always `--design-only` first; design is a
   human/driver checkpoint. Do not let "non-trivial" prompt-stop silently hang
   the loop — escalate as `needs-human-decision`.
8. **Closing issues is external.** Propose closes with evidence; do not mass-
   close without the user confirming (plan F3).
9. **Worktrees:** outside the main tree; `make -C <wt>`; no `git stash` in the
   cycle; flock around `.git/config` writes; exclusive lock for bench.
10. **Non-CI routed targets** must run locally when paths require them (at
    least): `make bun-buffer-tests`, `make api-surface`,
    `make test-compat-lava-strict`, `make bench-gate`, and when routed
    `make bench-http`. CI green ≠ cycle done.

## Phase playbooks

### status

1. Open `docs/agent-cycle-plan.md` implementation inventory table.
2. Check what exists on disk (hooks in `.claude/settings.json`, counters in
   runners, routing script, etc.).
3. Report: phase → status → next concrete action. Do not start work.

### F1 — Gate integrity

1. Implement command-level filter (Claude: `PreToolUse` hook script +
   `settings.json` `hooks`; Grok: equivalent deny/filter at tool boundary).
2. Cover the eight classes listed in the plan (env bypasses, baseline writes,
   case/bench deletion, mutation/property knobs, `--no-verify`).
3. Add case/bench **count assertions** + mutation-manifest entries.
4. Protect `.env` from Read if present.
5. Document the human-required path list for legitimate Makefile/scripts edits.
6. Update the plan's inventory table when done.
7. Gates: whatever the changed paths require (`make check-js` if scripts change,
   etc.). Never claim F1 done without a demonstrated blocked bypass (e.g.
   `NODE_BIN=./bin/lava make test-lava` rejected or still meaningful).

### F2 — Worktree safety

Apply the plan's table: fetch/multicore ports, `bun install` bootstrap,
gitignore/pid for fixture writers, `node_modules` ignore slash, bench flock
rules, orchestrator rules documented for F6. Verify two parallel smokes do not
cross-talk.

### F3 — Groom

1. Load open issues via `gh`.
2. Classify into plan buckets (a–e); do not invent new buckets.
3. Propose: close list with commit/PR evidence; residual rewrites; decompositions;
   human-only set; the 13 queue-as-is list (re-verify counts — plan numbers may
   drift).
4. For each issue kept open: draft `<!-- lava-task -->` + Acceptance against
   real code (contract + red test). Only ~12 have repros — read code for the rest.
5. Mark `reference/node-compat.json` stale in its header or README if still
   generated against an old SHA listing shipped modules as missing.
6. **Stop for human confirmation before closing or bulk-editing issues.**

### F4 — Routing

1. Generate route table from `Makefile` + `.github/workflows` (ci.yml).
2. Diff against `.claude/skills/pr-gate/reference/gates.md`.
3. Fix invalid globs, missing `bench-http`, mutation-manifest predicate, `__ALL__`
   fallback, `test-runtime-odin`.
4. Define L0 / L1 / L2 sets from measured times in the plan (re-measure if
   hardware differs; record method).
5. Prefer one build + direct `scripts/run-*.sh` with `LAVA_BIN` over N×
   `make <target>` relinks.

### F5 — Structured I/O

1. Define the findings JSON schema from the plan.
2. Wrapper prompts for all specialists under `.claude/agents/`.
3. Aggregator: severity-only; hard-stop on check/build fail with empty
   findings ≠ clean; SHIP/SHIP-AFTER/BLOCK per plan evaluator (no self-waive).

### F6 — Driver

Only after F1+F2+F4+F5. Implement:

```text
select ready issue → worktree bootstrap → implement
  → L0 → L1 → structured review → triage → requeue | terminal state
```

Terminal states: `done` | `blocked` | `needs-human-decision` (pre-spawn by
area/paths). Max 3 fix rounds; stall after 2 rounds with no open-count drop.
Never merge.

### F7 — Pilot

1. Prefer order: **#337 → (human #336) → #247** then other bucket-(a) ids from
   the plan.
2. Record week metrics from the plan.
3. If FP-requeue > 30%, narrow review — do not expand queue logic.

### min-slice

Execute F1, then F2, then implement/fix **#337** only. Document how a human
runs the 13 ready tasks manually. Do **not** start F6.

## Dual harness notes

| Concern | Claude Code | Grok Build |
| --- | --- | --- |
| Skill path | `.claude/skills/agent-cycle/` | `.grok/skills/agent-cycle/` (same body) |
| Plan | `docs/agent-cycle-plan.md` | same |
| Hooks | `.claude/settings.json` `hooks` + PreToolUse | tool deny / driver-side command filter; keep policy identical |
| Specialists | `.claude/agents/*` | same agents when spawned; use `pr-gate` skill |
| Features | `/odin-feature`, `/pr-gate` | same skills via Claude-compat discovery + this plan |
| Do not assume | — | `/design`, `/execute-plan`, Rhai workflows as in-repo Lava tools — they are Grok **bundled** globals, not this repository |

## Related

- [CLAUDE.md](../../../CLAUDE.md) §1 severity ranking, §6 tests, §8 AI pipeline
- [pr-gate](../pr-gate/SKILL.md) + [gates.md](../pr-gate/reference/gates.md) + [scoring.md](../pr-gate/reference/scoring.md)
- [odin-feature](../odin-feature/SKILL.md) — use `--design-only` inside the cycle
