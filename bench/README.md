# Benchmarks

Micro and macro benchmarks for the Lava runtime, measured **against Node as the oracle**
— the same ground-truth model the correctness tests use. Both runtimes run the identical
benchmark file on the same machine, so the reported **lava/node ratio** cancels the
machine's absolute speed and is what we compare and gate on.

## Run

```sh
make bench         # node-vs-Lava ratio table, report-only (never fails)
make bench-gate    # same, but fails if any ratio exceeds its cap in thresholds.json
```

Both build `bin/lava` first. Honor `NODE_BIN` / `LAVA_BIN` like the oracle runners:

```sh
LAVA_BIN=/path/to/lava NODE_BIN=/path/to/node ./scripts/run-bench.sh [--gate]
```

If `lava` is not runnable, the runner prints the Node baseline only (no ratios, no gate),
so the harness itself can be smoke-tested anywhere Node is present.

## Layout

- `lib/harness.js` — `bench(name, fn, opts)`: warms up, then times `iterations` calls of
  `fn` over `reps` repetitions and reports the **best** (min) wall time as a
  `##BENCH## {json}` line. Best-of-K suppresses GC/scheduler jitter. Runs under both Node
  and Lava (CommonJS; uses `performance.now()`, which both expose).
- `micro/` — `json`, `buffer`, `require` (cache-hit lookups); plus `noop.js`, the startup
  target spawned repeatedly to measure process boot.
- `macro/` — `fs` (64 KiB write+read throughput). Fetch throughput is a planned addition
  (needs a local origin, like the fetch smoke test).
- `run.mjs` — the orchestrator (Node): runs every bench under both runtimes, measures
  startup externally, prints the table, and applies the gate. All parsing/timing lives
  here (portable; no shell JSON parsing). `scripts/run-bench.sh` is a thin wrapper.
- `thresholds.json` — per-benchmark gate caps (max acceptable lava/node ratio).

## The gate, and calibrating it

`thresholds.json` ships with **generous starter caps**: they catch only catastrophic
regressions and are not meant to flake. CI currently runs `make bench` (report-only) so
the ratio table shows in the job log without ever failing the build.

To turn the gate on:

1. Run `make bench` (locally or read a CI run's table) to observe Lava's real ratios.
2. Tighten each cap in `thresholds.json` toward its observed ratio, leaving headroom for
   CI noise (a cap of ~1.5–2× the observed ratio is a reasonable start).
3. Flip the CI step from `make bench` to `make bench-gate` (`.github/workflows/ci.yml`).

A benchmark with no entry in `thresholds.json` is always report-only.
