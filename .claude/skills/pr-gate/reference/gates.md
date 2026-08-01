# Gate routing — which commands a change must pass

Source of truth is the `Makefile` and `.github/workflows/ci.yml`. If they
disagree with this table, they win — and fix this table.

**Who runs these.** On a PR, `ci.yml`'s Linux job executes the always-block plus
every routed smoke, on both I/O backends. Nothing else runs them: `/pr-gate` is
invoked by a human, locally, and `--review-only` (which executes no `make`
target and reads CI's conclusions instead) is for reviewing from a machine
without the toolchain. Four routed targets are **not** in CI — `make bun-buffer-tests`,
`make api-surface`, `make test-compat-lava-strict` and `make bench-gate` — so a
diff that routes to one of those needs a local run, or a new CI step if it should
be enforced. (`make test-scripts` runs in CI inside `make check-js`;
`make test-property` is its own CI step since batching took it from 64s to ~1s;
`make test-mutation` is its own CI step because it rebuilds `bin/lava` once per
embedded-JS mutation.)

## Always

| Command | Covers |
| ------- | ------ |
| `make check` | Odin type-check of `cmd/lava`, `pkg/runtime`, `eventloop`, `picohttpparser`, `pkg/std/sqlite`, `pkg/jsc` — **plus** cross-target front-end checks for `windows_amd64` and `darwin_arm64`. A change that breaks a platform stub fails here. |
| `make build` | Links `bin/lava`. Required before every `*-lava`, smoke, or bench target. |
| `make test` | Odin unit tests + oracle suites (`scripts/run-tests.sh`). |
| `make test-lava` | Every oracle suite the platform supports, node-vs-Lava (`run-oracles.sh`). |
| `make test-lava-nohostfn` | The same suites with `LAVA_HOSTFN_DISABLE=1`, i.e. every native built by the public C API instead of JSC's private host-call ABI. Runs unconditionally in CI and is the only coverage of the C-API fallback; a failure blocks like any always-gate, and doubly so for changes under `pkg/jsc`, `host_natives.odin`, or `require.odin`. |
| `make test-odin-serial` | `cmd/lava` tests on ONE runner thread — the only configuration where several `lava.eval` sites share a thread, and therefore the thread-local host-native registry and JSC's recycled context addresses. ~0.25s. |

`make fmt` (`odin strip-semicolon`) before committing Odin.
`make check-js` whenever any `.js`/`.mjs`/`.cjs` under `pkg/runtime/js`, `tests`,
`scripts`, or `bench` changed — it runs format, lint, orphan-JS detection, and the
primordials ratchet.
`make check-md` whenever any `.md` changed — markdownlint over the repo's own docs
(config and the rationale for its two disabled rules: `.markdownlint-cli2.jsonc`).
`make check-actions` whenever any `.github/workflows/*.yml` changed — actionlint
catches what a YAML parse cannot: a context used where it is not available, a bad
`needs`, shellcheck errors inside `run:`.

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
| `pkg/runtime/stdio*.odin`, `js/internal/stdio.js`, `tests/stdio/**` | `make test-stdio` — pins the non-blocking-fd retry loop that `console.log`, `lava eval` and `process.stdout.write` all share |
| `require.odin`, `module_resolution.odin`, `js/internal/{loader,esm}.js` | `make test-compat-lava-strict` |
| `crypto.odin`, `js/internal/crypto.js` | `make test-odin`, `make test-compat-lava`, `make api-surface` |
| `pkg/runtime/js/**.js` (any — the scan root is the whole tree, `console.js` included) | `make check-js`, `make check-primordials`, `make test-compat-lava` |
| `js/internal/url.js` | `make bench` — `bench/micro/url.js` exists since 2026-07-30; before it, a +6% to +20% `new URL` regression passed every gate and was found by hand in review |
| `js/internal/{encoding,url,buffer}.js`, `pkg/runtime/buffer*.odin` | `make test-property` — differential property tests (fast-check generates the corpus; hand-picked oracle cases missed edge cases here twice, and the batched suite found a utf-16le divergence at 5000 inputs). `PROPERTY_RUNS=N` for a deeper local sweep |
| `scripts/**` | `make test-scripts` — node:test over the build tooling |
| any file named in `tests/mutation-manifest.json` as a `source` | `make test-mutation` — re-applies the recorded break and requires the named test to go red. Changing one of these files without running it means the recorded mutation may no longer describe the code, which the runner reports as STALE rather than skipping |
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

Native-function creation has two backends for the same reason. Normally every
native is a JSC host function created through a dlsym'd private symbol; with
`LAVA_HOSTFN_DISABLE=1` (`make test-lava-nohostfn`) they all come from
`JSObjectMakeFunctionWithCallback` instead. The two are **not** observably
identical — `.length` and constructibility differ, see `inject_native_function` —
so a change to native registration is not verified from one of them either.

## Known-gap files

`known-lava-gaps.txt` (per suite) lists cases skipped under Lava.
`make test-compat-lava` skips them; `make test-compat-lava-strict` does not.
A diff that *adds* a path to a gap file is a regression needing an explicit reason.
