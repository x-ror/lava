# Gate routing — which commands a change must pass

Source of truth is the `Makefile` and `.github/workflows/ci.yml`. If they
disagree with this table, they win — and fix this table.

**Who runs these.** On a PR, `ci.yml`'s Linux job executes the always-block plus
every routed smoke, on both I/O backends. `.github/workflows/ai-review.yml` runs
`/pr-gate --review-only`, which executes none of them and reads that job's
conclusions instead. Four routed targets are **not** in CI —
`make bun-buffer-tests`, `make api-surface`, `make test-compat-lava-strict`, and
`make bench-gate` — so a diff that routes to one of those needs a local run, or a
new CI step if it should be enforced.

## Always

| Command | Covers |
| ------- | ------ |
| `make check` | Odin type-check of `cmd/lava`, `pkg/runtime`, `eventloop`, `picohttpparser`, `pkg/std/sqlite`, `pkg/jsc` — **plus** cross-target front-end checks for `windows_amd64` and `darwin_arm64`. A change that breaks a platform stub fails here. |
| `make build` | Links `bin/lava`. Required before every `*-lava`, smoke, or bench target. |
| `make test` | Odin unit tests + oracle suites (`scripts/run-tests.sh`). |
| `make test-lava` | Every oracle suite the platform supports, node-vs-Lava (`run-oracles.sh`). |

`make fmt` (`odin strip-semicolon`) before committing Odin.
`make check-js` whenever any `.js`/`.mjs`/`.cjs` under `pkg/runtime/js`, `tests`,
`scripts`, or `bench` changed — it runs format, lint, orphan-JS detection, and the
primordials ratchet.

## By path

| Changed path | Additionally required |
| ------------ | --------------------- |
| `pkg/runtime/buffer*.odin`, `typed_array.odin`, `pkg/jsc/**` | `make test-odin`, `make bun-buffer-tests`, `make api-surface`, `make bench` |
| `pkg/runtime/http.odin`, `js/internal/http.js`, `picohttpparser/**` | `make test-http-smoke` (runs both proactor and readiness backends), `make bench-http` |
| `pkg/runtime/net.odin`, `net_other.odin`, `js/internal/net.js` | `make test-net-smoke`, `make test-zerocopy-smoke` |
| `pkg/runtime/tls*.odin`, `tls_server.odin`, `js/internal/https.js` | `make test-https-smoke` (drives both backends internally) |
| `pkg/runtime/fetch*.odin`, `js/internal/fetch.js` | `make test-fetch-smoke` |
| `pkg/runtime/eventloop/**` | `make test-eventloop-odin`, `make test-eventloop-lava` |
| `pkg/runtime/fs*.odin`, `os_*.odin` | `make test-fs-lava` |
| `pkg/std/sqlite/**`, `sqlite.odin`, `js/internal/sqlite.js` | `make test-sqlite-odin`, `make test-sqlite-lava` |
| `pkg/runtime/dns.odin`, `fetch_dns.odin`, `js/internal/dns*.js` | `make test-compat-lava`, `make test-fetch-smoke` |
| `pkg/runtime/workers*.odin` | `make test-multicore-smoke` |
| `require.odin`, `module_resolution.odin`, `js/internal/{loader,esm}.js` | `make test-compat-lava-strict` |
| `crypto.odin`, `js/internal/crypto.js` | `make test-odin`, `make test-compat-lava`, `make api-surface` |
| `js/internal/**.js` (any) | `make check-js`, `make check-primordials`, `make test-compat-lava` |
| `pkg/runtime/globals.odin`, `runtime.odin`, `errors.odin` | `make test-odin`, `make test-compat-lava` |
| `bench/**`, `bench/thresholds.json` | `make bench-gate` — and a stated reason if a cap was loosened |
| `Makefile`, `scripts/**`, `.github/workflows/**` | run the targets the change touches, end to end |

## Perf claims

Any PR titled `perf(...)`, or claiming speed/memory anywhere in its body, must
carry numbers: `make bench` (ratio table), `make bench-http` (throughput, latency,
memory per idle connection), or a profile. JSC sampling profiler:
`JSC_useSamplingProfiler=1` plus a dump directory.

`make bench` is report-only in CI today. `make bench-gate` enforces
`bench/thresholds.json`; run it locally when touching a floor.

## Backends

Networking has two I/O backends. The smokes that take `LAVA_NET_FORCE_READINESS=1`
run **twice** (proactor and readiness) — do not report a networking change as
verified from one backend.

## Known-gap files

`known-lava-gaps.txt` (per suite) lists cases skipped under Lava.
`make test-compat-lava` skips them; `make test-compat-lava-strict` does not.
A diff that *adds* a path to a gap file is a regression needing an explicit reason.
