# Autonomous agent cycle — integration plan

Status: **IN PROGRESS** — F1–F6 infrastructure landed on this branch; F3 closes
and F7 pilot (except #337) still need human action. Source of truth for both
Claude Code and Grok Build. Skills: `.claude/skills/agent-cycle/`,
`.grok/skills/agent-cycle/`.

Composed from repo recon (5 parallel agents, 162 evidence-backed facts, 64 risks).
Numbers below are measured or cited from files unless marked otherwise.

**Do not build the driver first.** Phases 1–2–4–5 make the repo safe; phase 3
makes the backlog honest; phase 6 is the loop; phase 7 is the pilot.

---

## Why the cycle cannot be built first

### 1. Gates mutate via environment, not only files

A path deny-list catches only part of the surface. Real bypasses never touch
denied paths:

| Vector | Effect | Evidence |
| --- | --- | --- |
| `NODE_BIN=./bin/lava` | every oracle compare becomes lava-vs-lava → byte-identical by construction | `scripts/lib/compare.sh:32-35` (all 6 runners honor it) |
| `RUN_LAVA=0` | any `*-lava` target takes the node-only branch → all pass | `scripts/lib/compare.sh:67-71` |
| `rm bin/lava` | `bench-gate` exits 0 with "lava not runnable" | `bench/run.mjs:121-128,188-191` |
| `rm`/`mv` an oracle case | cases are a bare glob, no count → invisible | `scripts/run-node-compat-all.sh:18` |
| `rm bench/micro/x.js` | bench disappears with its cap | `bench/run.mjs:24-32` |
| `MUTATION_MANIFEST=` / `--filter=` | mutation gate looks at a foreign manifest | `scripts/run-mutations.mjs:79,88-91,96` |
| `PROPERTY_RUNS=1` | corpus 5000 → 1, validator still passes | `tests/property/decode.property.test.mjs:50-54` |
| `// primordials-ok` in source | silences the ratchet at the site; no path-deny catches it | `CLAUDE.md` §5 |

Static check (good news): **no gate rewrites a baseline as a side effect**. The only
write into `tests/node-compat/pollution-baseline.json` is `check-primordials.mjs:101`
under `--update`. `make check-js` is check-only.

**Consequence:** control is a **hook that regexes the full command**, plus
**in-repo counters** (oracle case count, bench count). File deletion is not
caught by path deny alone.

### 2. ~30% of the backlog is fiction; ~43% have no reachable done

~61 open issues. Classification against the tree:

| Bucket | n | Meaning for the cycle |
| --- | --: | --- |
| (a) ready task | 13 | only these may enter the queue as-is |
| (b) epic / multi-part | 26 | no reachable done — needs decomposition |
| (c) already done on master | 18 | agent will burn a full cycle rewriting shipped work |
| (d) research, no fix | 2 | `needs-human-decision` |
| (e) unverifiable as written | 2 | no in-repo test can close them |

Worst shipped-but-open: issues **78** (`node:os`), **79** (`node:stream`),
**80** (`node:net`), **81** (`node:http`) (commits `442a961`, `f0d28f3`,
`6e85c65`, `5243ecc`) plus 183, 159, 91, 107, 145, 243.

More dangerous: **half-merged** issues whose body still reads fully open
(#331, #266, #104, #105, #254, #255, #35). An agent rewrites the shipped half;
gates pass because behavior is already correct. Nothing flags that.

No priority labels exist. Order lives only as prose in three stale epics
(#112, #217, #40). Trap: `reference/node-compat.json` is generated against
`3de9128` and still lists net/os/http/https/dns as "missing" — a groom agent
that trusts it will re-queue shipped modules.

### 3. Both skills are human-gated by design

- `odin-feature/SKILL.md` — for non-trivial work, design is shown to the user
  before implement. The model itself judges "non-trivial". **Primary autonomy
  blocker.**
- `pr-gate/SKILL.md` — diffs 1–10 MB: ask first.
- `pr-gate/reference/scoring.md` — SHIP requires P1s fixed or **explicitly
  waived**. Waiver is human authorship on the PR. **Autonomous ceiling is
  SHIP-AFTER whenever P1 > 0.** Accept this; do not route around it.

No agent emits structured JSON. All ten write markdown with **different**
verdict enums. The only shared axis is `P0/P1/P2/nit` from `scoring.md`.
Aggregate on that axis only.

---

## Phase dependency graph

Phases 1, 2, 4, 5 are independent of each other. Phase 3 is independent but long.
Phase 6 needs 1+2+4+5. Phase 7 needs 3+6 (or a manual subset).

```text
   ┌── F1 gate-integrity ──┐
   ├── F2 worktree-safety ─┤
   ├── F4 routing ─────────┼──► F6 driver ──► F7 pilot
   ├── F5 structured I/O ──┘
   └── F3 groom ───────────────────────────► F7
```

**Minimum useful slice (2–3 days):** F1 + F2 + fix #337, then run the cycle
**manually** on the 13 bucket-(a) issues without a driver.

---

## F1 — Gate integrity

**Goal:** make "green without a fix" impossible. Without this, nothing else matters.

### 1.1 Command-regex hook

`.claude/settings.json` today has only `permissions` (prefix `Bash(...)` rules —
bypassable via `cd x && ENV=1 make ...`). No `hooks`. Need `PreToolUse(Bash)` that
reads JSON from stdin and exits 2 to block. Eight classes:

1. `--update` / `UPDATE=` / `RAISE=` / `--allow-raise` near `check-primordials`
2. `NODE_BIN=`, `LAVA_BIN=`, `RUN_LAVA=0`, `SKIP_KNOWN_LAVA_GAPS=`
3. `MUTATION_MANIFEST=`, `MUTATION_ROOT=`, `run-mutations.mjs --manifest|--root|--filter`, `FILTER=` with `test-mutation`
4. `PROPERTY_RUNS=`
5. shell write/delete of any baseline (`rm|mv|cp|sed|perl|awk|tee|truncate`, `>`), plus `git checkout/restore/rm` on them
6. `rm`/`mv`/`git rm` under `tests/{node-compat,runtime,std,property,stdio}/`, `bench/{micro,macro}/`, `bin/lava`
7. `sed -i` / `perl -i` on `scripts/`, `Makefile`, `package.json`, linter configs, `.github/workflows`
8. `--no-verify`

Plus `Edit`/`Write` deny on the inventory of protected paths from recon, and
`Read(.env)` — untracked root `.env` has held live tokens.

**Grok equivalent:** same policy as deny rules / PreToolUse where the harness
supports it; otherwise a driver-side command filter before every shell invoke.
Policy in the prompt alone is insufficient.

**Conscious compromise:** denying `Makefile`, `package.json`, and the four
`scripts/lib/primordials-*.mjs` blocks legitimate work — they are `source`
entries in the mutation manifest. Either accept friction or mark those paths
"human required".

### 1.2 Counters hooks cannot replace

Deletion is not reliably regex-caught (`git mv`, editor write). Structural fix —
**count assertions**:

- `tests/node-compat/cases` = 68, `tests/runtime/eventloop/cases` = 12,
  `tests/std/fs/cases` = 4, `tests/std/sqlite/cases` = 8 (re-measure at
  implement time; pin measured N in the runner)
- Every discovered bench under `bench/micro` + `bench/macro` must have a key in
  `bench/thresholds.json.caps` or an explicit opt-out — otherwise it is
  report-only forever

Add "found N cases, expected ≥ N from manifest" to runners, and cap/opt-out
coverage to `bench/run.mjs`. Both need mutation-manifest entries.

**Cost:** ~1 day. **Unblocks:** everything else.

---

## F2 — Parallel worktree safety

**Already good:** build is CWD-relative (`scripts/build.sh`, `Makefile`) — each
worktree writes its own `bin/lava`. Empirically verified: 3 parallel builds,
three binaries.

### What breaks

| Problem | Effect | Fix |
| --- | --- | --- |
| **fetch-smoke, port 8799** | second run hits the other server and **passes** without testing its build | per-agent `FETCH_TEST_PORT` + nonce in readiness probe |
| **multicore-smoke + SO_REUSEPORT** | co-bind one port; workers serve foreign requests; `distinct >= 2` is trivial | port below 32768 + process-group check |
| **no node_modules in worktree** | all JS gates fail `ERR_MODULE_NOT_FOUND` — cycle reads regression | `bun install --frozen-lockfile` in worktree bootstrap |
| **shared `.git/config`** | parallel `git push -u` → "could not lock config file" | flock around config writes |
| **shared `refs/stash`** | agent A pops agent B's stash | forbid `git stash` in the cycle entirely |
| **3 cases write into the tree** | `cases/{22,26,30}` write fixed paths under `tests/node-compat/fixtures/` (not gitignored) | gitignore + `process.pid` suffix |
| **bench under load** | `thresholds.json` documents 2.26× spread and 22–24% false positives | exclusive flock: bench only serially |
| **`node_modules` symlink** | `.gitignore:2` has a trailing slash → symlink dirty | drop the trailing slash |

### Orchestrator rules

- worktree **outside** the main tree (`git worktree add <relative>` creates inside
  and shows as `??` in the parent)
- `make -C <worktree>`, never `make -f <worktree>/Makefile`
- before `test-mutation`: commit — the gate requires specifically those 26 patched
  files clean; classify dirty refusal as SETUP-ERROR, not FAIL
- timeouts on `test-mutation`: SIGTERM only — restore hangs on `process.on('exit')`;
  SIGKILL leaves patched sources in the tree
- budget: ~2 cores + ~700 MB per job → 6 parallel on a 16-core box, **2 on CI**

**Cost:** ~1 day (small repo patches + driver rules).

---

## F3 — Groom ~61 issues

Without this, the first run rewrites `node:net`.

| Action | n | Issues |
| --- | --: | --- |
| close as shipped | 7 | #78 #80 #81 #79 #183 #159 #91 |
| close after verify | 4 | #107 #145 #243 #185 |
| rewrite to residual | 7 | #331 #266 #104 #105 #254\|#255 (dup) #35 |
| decompose | 26 | start #334 #328 #103 #84 #242 |
| mark human-only | 4 | #336 #65 #261 #186 |
| **queue as-is** | **13** | #337 #335 #332 #252 #250 #247 #245 #226 #193 #86 #85 #64 #66 |

Also: add a priority axis (labels do not exist), label the 14 unlabeled issues,
and mark `reference/node-compat.json` **stale** until regenerated.

Only ~12 of 61 bodies have a runnable repro; ~8 cite `file:line`. Groom for the
rest must read code to derive done. Closing issues is an external action —
human confirms closes.

**Cost:** 2–3 days agent-groom + human close review.

### Issue schema (source of truth = GitHub Issues, not a second backlog file)

```html
<!-- lava-task
priority: P1
blocked-by: [333]
blocks-surface: true
attempts: 0
review-tier: L1
-->
## Acceptance
- [ ] contract comment above the surface from a real `node` probe
- [ ] tests/node-compat/cases/NN-*.js red before the fix, green after
- [ ] mutation entry in tests/mutation-manifest.json when §6 requires it
- [ ] routed L0/L1 gates green
```

- **Acceptance** = contract comment (`CLAUDE.md` §4/§5) + red test written
  **before** implement (`CLAUDE.md` §6). Review measures against this list, not
  reviewer taste.
- `blocked-by` = DAG edges.
- `blocks-surface` = mutual exclusion for shared hot files; **computed from
  paths at runtime**, not hand-filled as the long-term source (hand seed ok
  during groom).
- `review-tier` = eventually a function of paths (F4); L2 only on PR-batch /
  merge candidates.

### Severity by defect class (not diff size)

| Class | Floor |
| --- | --- |
| Node parity deviation | never P2 |
| memory-safety / JSC lifetime | never P2 |
| security | never P2 |
| gate weakening (gaps, baseline raise, skip, cap loosen) | P0 |
| style, duplication, docstring | P2 — does not block cycle exit |

---

## F4 — Routing function

`gates.md` is **not ground truth** — it says so, and has already drifted:

- claims four targets not in CI — actually **five**: also `bench-http`
  (routed in `gates.md`, zero mentions in `ci.yml`)
- de-facto sixth gap: `make bench` is in CI but **report-only and cannot fail**
- `pkg/runtime/js/**.js` is an **invalid whole-segment `**` glob** — a naive
  parser matches zero files and silently drops the widest table row
- Makefile / scripts / workflows row is **prose with no target list** — needs
  `__ALL__` fallback
- mutation-manifest row is a **predicate**, not a glob — read the JSON at
  route time
- 12 pattern dialects, 2 of which are not globs
- `test-runtime-odin` is unmentioned — real test target with no route

### Tiers by measured time

| Level | Budget | Targets |
| --- | --- | --- |
| **L0** | <20s | `check-primordials`, `check-actions`, `check-md`, `fmt`, `test-scripts`, `check-js`, `test-odin-serial` |
| **L1** | <2 min | `check`, `test`, `test-lava`, smokes, `bench-gate`, plus non-CI routed: `bun-buffer-tests`, `api-surface`, `test-compat-lava-strict`, `bench-gate` (local), `bench-http` when routed |
| **L2** | minutes | `test-mutation` ~12–20 min, `bench-http` ~75s, `__ALL__` |

**Key saving:** `build` is `.PHONY` with no freshness check (~8.4s) and is a
prerequisite of ~25 targets. Routing `loader.js` (9 targets) burns ~76s on
relinks alone. Fix: build **once**, then call `scripts/run-*.sh` with
`LAVA_BIN=bin/lava` — that is what the recipes already do.

**Cost:** ~1 day. Generate the table from Makefile + `ci.yml` and **diff**
against `gates.md`; do not treat `gates.md` as the source.

---

## F5 — Structured output layer

Agents emit markdown. The driver needs a schema-forcing wrapper on every
specialist call:

```json
{
  "agent": "regression-hunter",
  "verdict_native": "string",
  "ran_commands": ["..."],
  "findings": [
    {
      "id": "F1",
      "severity": "P0|P1|P2|nit",
      "file": "path",
      "line": 0,
      "what": "...",
      "failure": "...",
      "evidence": "...",
      "fix": "...",
      "confidence": "high|medium|low"
    }
  ]
}
```

Aggregate **only** on `severity`. Native verdict enums are not shared.

Verdict evaluator (encodes `scoring.md` SHIP / SHIP-AFTER / BLOCK):

```text
if gate_red:                          BLOCK
if any(P0 has empty fix):             BLOCK
if len(P0) > MAX_P0:                  BLOCK      # driver constant; propose 2
if len(P0) > 0:                       SHIP-AFTER
if gate_unrun or gate_pending:        SHIP-AFTER
if len(P1) > 0:                       SHIP-AFTER # cycle must not self-waive
return SHIP
```

Two required branches:

1. `make check` / `make build` failure → **hard stop**, no specialists
   (`pr-gate/SKILL.md`). Empty findings must not read as "clean".
2. Call `odin-feature` with `--design-only`; design is a driver checkpoint.
   Otherwise phase 2 of that skill blocks on a human mid-loop.

Finding without `file:line` and without a concrete failure path → discard, not
a task.

**Cost:** 1–2 days.

---

## F6 — Driver

```text
groom → plan(DAG) → select → bootstrap(worktree) → implement
  → L0 → L1 → triage → requeue | done | needs-human-decision
```

- State lives in **GitHub Issues** (one source of truth).
- `blocked-by` = DAG.
- `blocks-surface` = computed mutual exclusion from changed paths.
- `review-tier` = function of paths via F4.
- Three terminal states: `done`, `blocked`, **`needs-human-decision`**
  (decided **before** spawn by area/paths — else #336 burns three rounds on the
  hook and escalates the same).
- Rules: severity by class; 3 review-fix rounds → human; 2 rounds with no
  decrease in open findings → human; merge to master → always human; one writer
  to the backlog.

**Cost:** 2–3 days.

---

## F7 — Pilot

Not on 61 issues. On the **13 bucket-(a)** tasks. First three are infrastructure
for the cycle itself:

1. **#337** — `check-global-replace` keyed by line number; any edit above a site
   turns `make check-js` red with a false hang report. In #330 the site moved
   three times in one PR. Until fixed, every agent that touches `util.js` burns
   a round.
2. **#336** — `bench-gate` red on master. **Human-only:** `thresholds.json`
   itself offers a third explanation not in the issue ("cap flips with pinning,
   1.52× pinned") — an agent can "fix" a correct cap.
3. **#247** — `node:process` / `node:console` hand out a lazily-read global
   instead of the intrinsic. Same class as #333; verified adversarially.

### Week metrics

| Metric | Action if bad |
| --- | --- |
| tasks / day | — |
| review rounds / task | — |
| % findings confirmed on re-verify | low → tighten prompts / evidence rules |
| false-positive requeue rate | if **> 30%** → narrow review, do not expand queue logic |
| wall-time L0 vs L1 | — |

---

## Cost summary

| Phase | Days | Blocks |
| --- | --: | --- |
| F1 gate-integrity | 1 | everything |
| F2 worktree-safety | 1 | parallelism |
| F4 routing | 1 | tiering |
| F5 structured I/O | 1–2 | aggregation |
| F3 groom | 2–3 | honest queue fill |
| F6 driver | 2–3 | — |
| F7 pilot | 2 | — |

**Total ~10–13 days.** Driver alone is 2–3. The rest is making the repo and
backlog safe enough that an autonomous loop does not harm the tree.

---

## Implementation inventory (when a phase is executed)

Track progress here (edit in place; do not open a second tracker):

| Phase | Status | Notes |
| --- | --- | --- |
| F1.1 hooks / command filter | **done** | `scripts/agent-cycle/gate-integrity.mjs`, `.claude/hooks/`, `.grok/hooks/`, settings deny+hooks; runner refuse lava-vs-lava |
| F1.2 case/bench counters | **done** | `case-counts.json` + assert in oracle runners; bench min files + `report_only` + fail if lava missing under `--gate` |
| F2 worktree fixes | **done** | fetch nonce/port, multicore port, fixture pid suffix, gitignore, `worktree-bootstrap.sh` |
| F3 issue groom | proposal | `docs/agent-cycle/groom-report.md` — human confirms closes |
| F4 routing generator | **done** | `scripts/agent-cycle/route-gates.mjs`; gates.md notes 5 non-CI + invalid glob fixed |
| F5 structured I/O wrapper | **done** | `findings-schema.json` + `aggregate-verdict.mjs` |
| F6 driver | **skeleton** | `scripts/agent-cycle/driver.mjs` — select/plan/route/aggregate; no LLM spawn |
| F7 pilot | partial | **#337 fixed** (ALLOWED keyed by binding); #336 human-only; rest not run |

---

## What this plan deliberately does not do

- Second backlog file (`.lava/backlog.yaml`) next to GitHub Issues
- Treating Grok-only bundled skills (`/design`, `/execute-plan`, Rhai workflows
  under `~/.grok/bundled`) as if they lived in this repo — they do not. Lava has
  `odin-feature` and `pr-gate` only under `.claude/skills/`
- Self-waiving P1s to force SHIP
- Running full specialist fan-out (L2 / full `pr-gate`) on every 20-line fix
- Parallel bench under load without an exclusive lock
