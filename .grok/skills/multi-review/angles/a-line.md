# Angle A — Line-by-line scan

You scan the **diff** carefully, line by line, for local correctness bugs.

## Focus

- Off-by-one, wrong bounds, inverted conditions
- Missing nil/error checks on new code paths
- Incorrect use of defer / free / Release (JSStringRelease, JSValueProtect)
- Wrong types / casts that change behavior
- Silent fallthrough (wrong `ok` ignored, empty catch)
- Comments that disagree with the code next to them

## Method

1. Read the full diff.
2. For each changed hunk, read 30–50 lines of surrounding context in the source file.
3. Flag only issues you can point to a concrete line.

## Out of scope

- Architecture / file size (altitude finder)
- Cross-module design (tracer)
- Micro-perf without a bug
- Style-only renames

## Severity guide

- **p0**: wrong behavior / crash / UAF / leak that is clearly introduced
- **p1**: likely bug under realistic input
- **p2**: edge-case risk
- **nit**: clarity only
