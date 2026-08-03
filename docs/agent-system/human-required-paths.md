# Human-required / hard-blocked paths

1. **Hard block** — PreToolUse hook (`runtime/gates/integrity.mjs` + settings deny).
2. **Human-required** — legitimate work needs a human with hooks relaxed.

## Self-protect (never agent-writable)

| Path                                        | Why                  |
| ------------------------------------------- | -------------------- |
| `runtime/gates/integrity.mjs`               | empty the filter     |
| `runtime/gates/case-counts.json`            | case-count floor     |
| `runtime/gates/assert-case-counts.mjs`      | counter assertion    |
| `config/agents.json` / `config/agents.yaml` | registry rewrite     |
| `config/pipeline.json`                      | DAG rewrite          |
| `workflows/pipeline.mjs`                    | bypass PR gate       |
| `commands/index.mjs`                        | command layer bypass |
| `.claude/settings.json` / hooks             | disable protections  |
| `scripts/lib/compare.sh`                    | oracle spine         |
| `tests/mutation-manifest.json`              | mutation gate        |
| `bench/thresholds.json`                     | bench caps           |
| `tests/node-compat/pollution-baseline.json` | primordials floor    |
| `**/known-lava-gaps.txt`                    | coverage shrinkage   |
| `Makefile` / `package.json`                 | gate recipes         |

See `PROTECTED_WRITE_PATHS` in `runtime/gates/integrity.mjs` for the live list.
