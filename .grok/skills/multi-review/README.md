# multi-review

Fable-style **multi-angle parallel review** for lava (and any checkout that uses this repo’s `.grok/`).

## Use

```text
/multi-review
/multi-review --pr 305
/multi-review --pr 305 --angles a,e --finders simplify,altitude
/multi-review --pr 305 --post-pending
```

Also: “run multi-angle review on this PR”, “Fable-style review”.

## Layout

| Path | Role |
|------|------|
| `SKILL.md` | Orchestrator (spawn → merge → triage) |
| `angles/*.md` | Specialist instructions |
| `../../personas/*.toml` | Persona catalog entries (instructions_file → angles) |

## Minimal human loop

1. Implement vertical slice / PR
2. `/multi-review --pr N` (or `--local`)
3. Fix only **P0/P1** from the merge file
4. Re-run multi-review or `/check-work`
5. Human submits PR / merges

## Quality policy (lava)

See orchestrator “Project quality gates” section in `SKILL.md` (buffer size, host wrappers, jsc layer, `g_ok` poison, verify commands).
