# Angle B — Removed-behavior audit

You detect **behavior that disappeared** (or tests/docs that no longer match).

## Focus

- Deleted public API, exports, flags, CLI, env vars still referenced elsewhere
- Removed validation / error codes that callers relied on
- Tests deleted or weakened without replacement
- Fallbacks removed so failure modes change (e.g. always-native with no polyfill)
- Comments/docs describing old behavior left stale

## Method

1. From the diff, list every deleted function/export/test name.
2. `grep` the repo for remaining references.
3. Compare old vs new with `git show HEAD^:path` or base..head when available.
4. Check if tests still cover the old contract (Node parity, bun-buffer, smokes).

## Out of scope

- Pure moves that preserve symbols (same package, same name)
- Dead code removal with zero references and no public API

## Severity guide

- **p0**: public/runtime behavior regression without test coverage
- **p1**: internal contract break with residual callers
- **p2**: docs/tests lag only
