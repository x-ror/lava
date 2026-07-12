---
name: multi-review
description: >
  Multi-angle parallel code review for high-quality merges with minimal human
  reading. Spawns read-only subagents for angles A–E (line-by-line, removed
  behavior, cross-file tracer, language pitfalls, probe/thread-safety) plus
  reuse / simplification / efficiency / altitude finders, then merges findings
  into one triage report. Use when the user runs /multi-review, asks for
  multi-angle review, Fable-style review agents, or high-quality automated
  review of a PR, branch, or local diff.
argument-hint: "[--local | --branch <name> | --pr <number-or-url>] [--angles a,b,c|all] [--finders reuse,simplify,efficiency,altitude|all] [--post-pending]"
---

# Multi-Angle Review (Fable-style quality pipeline)

You are an **orchestrator only**. You do not author deep findings yourself.
You collect a diff, launch **read-only** specialist subagents in parallel
(each with a fixed angle or finder), merge their notes, triage severity, and
report. Optional: post a PENDING GitHub review.

Human role stays small: read the triage table, fix P0/P1 (or ask you to fix),
submit the PR review / merge.

## Invocation

```
/multi-review                         # local uncommitted changes
/multi-review --local
/multi-review --branch perf/buffer
/multi-review --pr 305
/multi-review --pr 305 --angles a,e --finders simplify,altitude
/multi-review --pr 305 --post-pending # also create PENDING GH review
```

### Argument parsing

1. Empty → `MODE=local`
2. `--local` → local
3. `--branch <name>` → branch mode
4. `--pr <id-or-url>` → PR mode
5. Plain `#?\d+` or github pull URL → PR; else try as branch
6. `--angles <list|all>` default `all` (`a,b,c,d,e`)
7. `--finders <list|all>` default `all` (`reuse,simplify,efficiency,altitude`)
8. `--post-pending` only meaningful with PR mode (default off)

## Angle / finder map

| ID | Name | Instruction file (relative to this skill) |
|----|------|-------------------------------------------|
| a | Line-by-line scan | `angles/a-line.md` |
| b | Removed-behavior audit | `angles/b-removed.md` |
| c | Cross-file tracer | `angles/c-tracer.md` |
| d | Language pitfalls | `angles/d-language.md` |
| e | Probe / thread-safety | `angles/e-probe.md` |
| reuse | Reuse finder | `angles/finder-reuse.md` |
| simplify | Simplification finder | `angles/finder-simplify.md` |
| efficiency | Efficiency finder | `angles/finder-efficiency.md` |
| altitude | Altitude / layer finder | `angles/finder-altitude.md` |

Resolve absolute path: directory of this `SKILL.md` + `/angles/...`.

## Setup

```bash
umask 077
python3 -c "import uuid; print(uuid.uuid4().hex[:8])"
scratch_dir="${TMPDIR:-/tmp}/grok-$(id -u)"; mkdir -p "$scratch_dir" && chmod 700 "$scratch_dir" && echo "$scratch_dir"
```

Store `REVIEW_ID` and `scratch_dir`. Paths:

- `diff_file`: `${scratch_dir}/multi-review-diff-${REVIEW_ID}.diff`
- `files_list`: `${scratch_dir}/multi-review-files-${REVIEW_ID}.txt`
- `agent_out_dir`: `${scratch_dir}/multi-review-out-${REVIEW_ID}/` (mkdir)
- `merge_file`: `${scratch_dir}/multi-review-merge-${REVIEW_ID}.md`
- Each agent writes: `${agent_out_dir}/${id}.md` (e.g. `a.md`, `reuse.md`)

## Step 1 — Collect diff

Mirror the collection logic from the bundled `/review` skill:

- **local**: `git diff HEAD` + untracked as `--no-index` diffs; names → files_list
- **branch**: merge-base vs `origin/main` or `origin/master`, then `git diff MB..branch`
- **pr**: `gh pr view` + `gh pr diff`; auth required

Empty diff → report "nothing to review" and stop.

Size gate: >10MB abort; >1MB ask user before continuing.

Report: `Collected diff (N files). Launching K specialists...`

## Step 2 — Launch specialists in parallel

For each selected angle/finder:

1. `read_file` the angle instruction markdown.
2. `spawn_subagent` with:
   - `subagent_type`: `"explore"` if pure research is enough; prefer `"general-purpose"` with `capability_mode: "read-only"` so they can still use shell read-only (`git`, `rg`) when needed. Use `capability_mode: "execute"` only if the angle needs `git show` / `gh` (still **no file edits** — instruct not to write source).
   - `background`: `true` (run all in parallel)
   - `description`: `"[multi-review] <id> <short>"` e.g. `"[multi-review] e probe/thread-safety"`
   - `prompt`: template below

### Specialist prompt template

```
You are a specialized code-review agent. You do NOT edit source files.
You only write findings to the notes file.

## Your specialty instructions

<paste full contents of angles/<id>.md here>

## Scope

Mode: <mode>
Target: <target summary>
Diff file (read this first): <diff_file>
Changed files list: <files_list>
Repo root: <absolute path to lava>

Also read surrounding source with read_file/grep when the diff is insufficient.
For removed-behavior and cross-file work, use git show / git log as needed.

## Output contract

Write Markdown to EXACTLY this path (create/overwrite):
  <agent_out_dir>/<id>.md

Format:

# Angle/Finder: <name>

## Verdict
One of: clean | issues | blocker-risk
1-3 sentences.

## Findings

### F1 -- Severity: p0|p1|p2|nit
- File: path:line
- Title: short
- Description: what is wrong / missing
- Evidence: quote or symbol
- Suggestion: concrete fix
- Confidence: high|medium|low

(Repeat F2, F3... If none: "## Findings" then "None.")

## Notes
Optional: what you skipped or could not prove.

Rules:
- Prefer high-confidence issues over volume
- Every finding needs File: with a line when possible
- Do not invent style nits if the specialty is correctness
- Do not modify any repo source file
```

Launch all selected agents **in one assistant turn** (multiple `spawn_subagent` calls). Then `get_command_or_subagent_output` with all task_ids and a generous `timeout_ms` (e.g. 600000).

If an agent fails or its output file is missing, record that specialist as `failed` and continue.

## Step 3 — Merge & triage

Read every `${agent_out_dir}/*.md`. Build `merge_file`:

```markdown
# Multi-review merge

- Mode / target: ...
- Specialists run: ...
- Failed specialists: ...

## Severity counts
- P0: N
- P1: N
- P2: N
- nit: N

## Human action list (minimal)
1. ... only P0/P1, deduped across agents ...

## Deduped findings
### [P0] title
- Agents: a, e
- File: ...
- ...

## Per-agent summaries
| ID | Verdict | #Findings |
...
```

**Dedup rules:**

- Same file:line + similar title → one finding, list all agent IDs
- Prefer higher severity and higher confidence when merging
- Drop pure duplicate nits from 3+ agents if already covered by P1

**Triage for "minimal human":**

| Severity | Meaning | Human? |
|----------|---------|--------|
| p0 | correctness / safety / data race / wrong API | yes — fix before merge |
| p1 | structural / maintainability blocker (1k file, wrong layer, poison flag) | yes — fix or explicit waive |
| p2 | solid improvement | optional same PR |
| nit | style | ignore unless free |

## Step 4 — Optional PENDING GitHub review

Only if `MODE=pr` **and** `--post-pending` **and** at least one p0/p1/p2:

- Build JSON like the `/review` skill (no `event` field → PENDING)
- Inline comments only for findings whose (file,line) exist on the RIGHT side of the PR diff
- Promote the rest to review body
- `gh api repos/.../pulls/.../reviews --input ...`

If zero actionable findings, do **not** post an empty review.

## Step 5 — Final report to user

Print a short block:

```
Multi-review complete.
- Target: ...
- Specialists: K (failed: ...)
- P0: n  P1: n  P2: n  nit: n
- Merge file: <merge_file>
- Human must handle: <only P0/P1 titles, or "none">
- Next: fix P0/P1 then re-run /multi-review --pr N
  (or: ask me to implement the human action list)
```

Keep `merge_file` and agent outs on disk (mode 0600). Delete only the raw diff if huge (>2MB) after merge.

## Project quality gates (lava) — inject into merge if relevant

When reviewing lava buffer/jsc/http changes, also score against:

1. `pkg/runtime/buffer.odin` should not sit permanently above ~1000 lines without a split plan
2. Dedicated `*_host` wrappers only for measured hot natives; cold use generic host path
3. UTF-16→UTF-8 bridge helpers belong near `pkg/jsc`, not `environment.odin`
4. Private ABI: do not set `g_ok=false` on transient runtime alloc failure (probe/self-test only)
5. Prefer pure vertical refactors + `make check` / bun-buffer / http-smoke / bench-gate

Mention violations as p1 even if no agent specialized on them (orchestrator may add a single "Policy" section after merge — allowed exception to "orchestrator does not invent findings", limited to these five rules and only with file:line evidence).

## Rules

- Specialists are **read-only** (no source edits)
- Orchestrator does not deep-review the whole diff alone
- Parallel spawn by default
- No emojis
- Prefer fewer high-conviction findings
- Never force-push or submit a GitHub review for the user (PENDING only when asked)
- If user says "fix the multi-review findings", that is a **new** task (implement), not this skill
