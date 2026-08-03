# Human-required / hard-blocked paths (agent-cycle F1)

Agents must not weaken gates. Two layers enforce that:

1. **Hard block** — PreToolUse hook (`scripts/agent-cycle/gate-integrity.mjs`
   `PROTECTED_WRITE_PATHS` + command regex) and `.claude/settings.json` `deny`.
2. **Self-protect** — the deny list and the hook script themselves are hard-blocked.
   An agent that edits `.claude/settings.json` to drop denials is the classic
   bypass; both the hook and the settings deny list block that path.

## Hard-blocked (Edit/Write + shell rewrite)

| Path | Why |
| --- | --- |
| `.claude/settings.json` / `.local.json` | **self-protect** — removing denials |
| `.claude/hooks/**`, `.grok/hooks/**` | **self-protect** — removing PreToolUse |
| `scripts/agent-cycle/gate-integrity.mjs` | **self-protect** — empty the filter |
| `scripts/agent-cycle/case-counts.json` | case-count floor |
| `scripts/agent-cycle/assert-case-counts.mjs` | counter assertion |
| `scripts/lib/compare.sh` | lava-vs-lava refusal (oracle spine) |
| `scripts/lib/primordials-*.mjs`, `check-primordials.mjs` | ratchet / mutation sources |
| `scripts/run-mutations.mjs` | mutation gate honesty |
| `scripts/run-*-oracle.sh`, `run-node-compat-all.sh` | counters + RUN_LAVA path |
| `bench/run.mjs`, `bench/thresholds.json` | bench-gate integrity / caps |
| `tests/mutation-manifest.json` | mutation inventory |
| `tests/*/known-lava-gaps.txt` | intentional skip list |
| `tests/node-compat/pollution-baseline.json` | primordials baseline |
| `Makefile`, `package.json` | gate graph / tooling |
| `.github/workflows/**` | CI surface |
| `bin/lava`, `.env` | binary under test / secrets |

## Command-level blocks (regex, not path)

Still blocked even when no protected file is named: `NODE_BIN=`, `RUN_LAVA=0`,
`PROPERTY_RUNS=`, `MUTATION_MANIFEST=`, `SKIP_KNOWN_LAVA_GAPS=`, `--no-verify`,
`git stash` (mutating forms), `check-primordials` + `UPDATE=`/`--update`,
`rm` of oracle cases / benches, `sed -i` on scripts/Makefile/settings.

`cd x && NODE_BIN=…` is covered by the same env-assignment rules.

## How a human changes a hard-blocked path

1. Stop the agent (or run outside the harness).
2. Edit the file yourself (or temporarily remove the deny / set
   `disableAllHooks` knowing the risk).
3. Record the reason in the PR body.
4. Re-enable hooks before further agent work.

Legitimate product work on `Makefile` / `compare.sh` / primordials **is** human-
gated by design (agent-cycle plan F1 compromise accepted as hard-block, not
prompt-only).
