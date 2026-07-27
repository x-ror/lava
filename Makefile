ODIN ?= odin
ifeq ($(OS),Windows_NT)
# Native Windows GNU Make defaults to cmd.exe, but every recipe here is POSIX shell
# (inline VAR=val env, bare ./scripts/*.sh, rm -rf, printf …). Run them through Git Bash
# so the same recipes work as on Linux/macOS; otherwise `make bench`/`clean`/test-*-lava
# fail under cmd.exe with errors like "'LAVA_BIN' is not recognized".
#
# Point at Git Bash by its full path on purpose: a bare `bash` on the Windows PATH is
# typically WSL's bash.exe (under WindowsApps), which runs in a Linux VM that cannot see
# the Windows build tree. Override if Git for Windows lives elsewhere, e.g.
#   make bench GIT_BASH="D:/Git/bin/bash.exe"
GIT_BASH ?= C:/Program Files/Git/bin/bash.exe
SHELL := $(GIT_BASH)
# SHELL alone isn't enough on Windows: make "direct-executes" simple single-command
# recipes (a bare ./scripts/x.sh, rm -rf …) without the shell, so they run via the
# script's shebang and die ("env" isn't on the Windows PATH). Prefix those recipes with
# $(RUNSCRIPT) to force them through Git Bash. (Empty on Unix — the default shell already
# runs them and respects each script's own shebang.)
RUNSCRIPT := "$(GIT_BASH)"
LAVA ?= build/lava.exe
else
RUNSCRIPT :=
LAVA ?= bin/lava
endif
SOURCE ?= console.log('hello from Lava')
FILE ?=

.PHONY: help bootstrap-windows-deps build-sqlite-windows build run eval check check-cli check-runtime check-js fix-js check-md fix-md check-actions check-primordials check-jsc check-native native-deps test test-all test-lava api-surface vendor-bun-report bun-buffer-report bun-buffer-tests test-compat test-compat-lava test-compat-lava-strict test-odin test-eventloop-odin test-runtime-odin test-sqlite-odin test-sqlite-node test-sqlite-lava test-fs-node test-fs-lava test-eventloop-node test-eventloop-lava test-fetch-smoke test-net-smoke test-http-smoke test-https-smoke test-multicore-smoke test-zerocopy-smoke bench bench-gate bench-http fmt clean

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make bootstrap-windows-deps Fetch ignored Windows native deps into .deps/'
	@printf '%s\n' '  make build-sqlite-windows Build build/sqlite3.lib via MSVC'
	@printf '%s\n' '  make run FILE=app.js    Run a JavaScript file through lava'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate JavaScript source through lava'
	@printf '%s\n' '  make check              Type-check Odin packages'
	@printf '%s\n' '  make check-cli          Type-check the CLI package'
	@printf '%s\n' '  make check-runtime      Type-check runtime packages'
	@printf '%s\n' '  make check-js           Run Vite+ lint and formatting checks for JavaScript'
	@printf '%s\n' '  make fix-js             Auto-fix JavaScript formatting/lint issues with Vite+'
	@printf '%s\n' '  make check-md           Markdown lint over the repo docs (markdownlint-cli2)'
	@printf '%s\n' '  make fix-md             Auto-fix markdown lint issues'
	@printf '%s\n' '  make check-actions      actionlint over .github/workflows'
	@printf '%s\n' '  make check-primordials  Prototype-pollution ratchet over embedded JS (UPDATE=1 to rebaseline)'
	@printf '%s\n' '  make check-jsc          Locate JavaScriptCore dev files (macOS framework or GTK) with install hints'
	@printf '%s\n' '  make check-native       Verify native build dependencies via pkg-config'
	@printf '%s\n' '  make test               Run Odin and Node compatibility tests'
	@printf '%s\n' '  make test-all           Run unified test script (Odin + oracle suites)'
	@printf '%s\n' '  make test-lava          Compare every supported oracle suite through Lava (run-oracles.sh)'
	@printf '%s\n' '  make api-surface        Report Buffer/Crypto API surface differences vs Node'
	@printf '%s\n' '  make vendor-bun-report  Summarize vendored Bun node compatibility corpus'
	@printf '%s\n' '  make bun-buffer-report  List vendored Bun buffer tests and adapted ports'
	@printf '%s\n' '  make bun-buffer-tests   Run/compare the ported Bun buffer cases (node vs Lava)'
	@printf '%s\n' '  make test-compat        Run all active Node compatibility tests with Node'
	@printf '%s\n' '  make test-compat-lava   Build and compare active compatibility tests through Lava, skipping known gaps'
	@printf '%s\n' '  make test-compat-lava-strict Build and compare active compatibility tests through Lava without skips'
	@printf '%s\n' '  make test-odin          Run Odin tests for the CLI package'
	@printf '%s\n' '  make test-eventloop-odin Run Odin event-loop core tests'
	@printf '%s\n' '  make test-sqlite-node   Run SQLite std tests with Node as oracle'
	@printf '%s\n' '  make test-sqlite-lava   Build and compare SQLite std tests through Lava'
	@printf '%s\n' '  make test-fs-node       Run node:fs std tests with Node as oracle'
	@printf '%s\n' '  make test-fs-lava       Build and compare node:fs std tests through Lava (cross-platform)'
	@printf '%s\n' '  make test-eventloop-node Run event-loop ordering tests with Node as oracle'
	@printf '%s\n' '  make test-eventloop-lava Build and compare event-loop tests through Lava, skipping known gaps'
	@printf '%s\n' '  make test-fetch-smoke   Compare fetch over a real socket node vs Lava (binds a local port)'
	@printf '%s\n' '  make bench              Run benchmarks node-vs-Lava, print a ratio table (report-only)'
	@printf '%s\n' '  make bench-gate         Run benchmarks and fail if any lava/node ratio exceeds its cap'
	@printf '%s\n' '  make fmt                Strip optional semicolons in Odin sources'
	@printf '%s\n' '  make clean              Remove build artifacts'
	@printf '%s\n' ''
	@printf '%s\n' 'Env knobs (for the node-compat and event-loop runners):'
	@printf '%s\n' '  RUN_LAVA=1              Compare each case Node-vs-Lava instead of Node-only'
	@printf '%s\n' '  SKIP_KNOWN_LAVA_GAPS=1  Skip paths listed in the matching known-lava-gaps.txt'
	@printf '%s\n' '  NODE_BIN=/path/to/node  Override the Node oracle binary'

bootstrap-windows-deps:
	$(RUNSCRIPT) ./scripts/bootstrap-windows-deps.sh

ifeq ($(OS),Windows_NT)
build-sqlite-windows:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-sqlite-windows.ps1
else
build-sqlite-windows:
	bash ./scripts/build-sqlite-windows.sh
endif

ifeq ($(OS),Windows_NT)
build:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
else
build:
	./scripts/build.sh
endif

run: build
	@test -n "$(FILE)" || { printf '%s\n' 'usage: make run FILE=app.js'; exit 2; }
	$(LAVA) run "$(FILE)"

eval: build
	$(LAVA) eval "$(SOURCE)"

check: check-cli check-runtime
	$(ODIN) check pkg/jsc -no-entry-point

check-cli:
	$(ODIN) check cmd/lava -collection:lava=.

check-runtime:
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=.
	$(ODIN) check pkg/runtime/eventloop -no-entry-point
	$(ODIN) check pkg/runtime/picohttpparser -no-entry-point
	$(ODIN) check pkg/std/sqlite -no-entry-point
	# Cross-platform front-end check (no link): catches a compile/symbol regression in the
	# non-Linux stubs (net_other.odin) and the linux,windows TLS bindings before they reach a
	# Windows/macOS build. `odin check` doesn't link, so it can't fully prove symbol elision.
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=. -target:windows_amd64
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=. -target:darwin_arm64

# Compile vendored C deps (picohttpparser) Odin links into the runtime. Idempotent;
# `odin check` does not need it, but every link of cmd/lava (build, test-odin) does.
native-deps:
	$(RUNSCRIPT) ./scripts/build-native-deps.sh

check-js:
	vp run js:check

fix-js:
	vp run js:fix

# Markdown lint over the repo's own docs (config + rationale for the two disabled rules:
# .markdownlint-cli2.jsonc). Catches MD040 and friends locally instead of in review.
check-md:
	vp run md:check

fix-md:
	vp run md:fix

# actionlint (WASM build, no Go toolchain) over .github/workflows. Catches the semantic
# mistakes a YAML parse cannot: contexts used where they are not available, bad `needs`,
# shellcheck errors inside `run:` blocks.
check-actions:
	vp run actions:check

# Prototype-pollution ratchet over the embedded runtime JS (also part of check-js).
# Run with UPDATE=1 to rewrite the baseline after hardening a module.
check-primordials:
	@if [ "$(UPDATE)" = "1" ]; then node scripts/check-primordials.mjs --update; \
	else node scripts/check-primordials.mjs; fi

check-jsc:
	$(RUNSCRIPT) ./scripts/check-jsc.sh

check-native:
	$(RUNSCRIPT) ./scripts/check-native-deps.sh

ifeq ($(OS),Windows_NT)
test: test-odin test-eventloop-odin test-sqlite-odin
else
test: test-all
endif

test-all:
	$(RUNSCRIPT) ./scripts/run-tests.sh

api-surface: build
	$(RUNSCRIPT) ./scripts/report-api-surface.sh

vendor-bun-report:
	$(RUNSCRIPT) ./scripts/report-vendored-bun.sh

bun-buffer-report:
	$(RUNSCRIPT) ./scripts/report-vendored-bun.sh buffer

bun-buffer-tests: build
	LAVA_BIN="$(LAVA)" ./scripts/report-bun-buffer-tests.sh

test-compat:
	$(RUNSCRIPT) ./scripts/run-node-compat-all.sh

test-compat-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-compat-lava-strict: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-odin: native-deps
	$(ODIN) test cmd/lava -collection:lava=.

test-eventloop-odin:
	$(ODIN) test pkg/runtime/eventloop

test-runtime-odin:
	$(ODIN) test pkg/runtime -collection:lava=.

ifeq ($(OS),Windows_NT)
test-sqlite-odin:
	powershell -NoProfile -ExecutionPolicy Bypass -Command "if (!(Test-Path 'build/sqlite3.lib')) { Write-Host 'skipping pkg/std/sqlite Odin link test (missing build/sqlite3.lib; run Windows bootstrap/MSVC build first)'; exit 0 }; $$env:LIB = (Resolve-Path 'build').Path + ';' + $$env:LIB; & '$(ODIN)' test pkg/std/sqlite; exit $$LASTEXITCODE"
else
test-sqlite-odin:
	$(ODIN) test pkg/std/sqlite
endif

test-sqlite-node:
	$(RUNSCRIPT) ./scripts/run-sqlite-oracle.sh

test-sqlite-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-sqlite-oracle.sh

test-fs-node:
	$(RUNSCRIPT) ./scripts/run-fs-oracle.sh

test-fs-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-fs-oracle.sh

test-eventloop-node:
	$(RUNSCRIPT) ./scripts/run-eventloop-oracle.sh

test-eventloop-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-eventloop-oracle.sh

test-fetch-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-fetch-smoke.sh

test-net-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-net-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-net-smoke.sh

test-http-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-http-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-http-smoke.sh

# The https smoke drives BOTH backends itself (proactor + readiness inside the script), so it is a
# single invocation unlike the http/zerocopy smokes.
test-https-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-https-smoke.sh

test-multicore-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-multicore-smoke.sh

test-zerocopy-smoke: build
	LAVA_BIN="$(LAVA)" ./scripts/run-zerocopy-smoke.sh
	LAVA_BIN="$(LAVA)" LAVA_NET_FORCE_READINESS=1 ./scripts/run-zerocopy-smoke.sh

# bench runs the micro/macro benchmarks node-vs-Lava and prints a ratio table; it never
# fails on timing (report-only). bench-gate adds --gate, enforcing the per-benchmark
# lava/node ratio caps in bench/thresholds.json (exit non-zero on a regression).
bench: build
	LAVA_BIN="$(LAVA)" ./scripts/run-bench.sh

bench-gate: build
	LAVA_BIN="$(LAVA)" ./scripts/run-bench.sh --gate

# HTTP server benchmark: hello-world throughput (req/s, latency) and memory-per-idle-
# connection for Lava vs Node vs Bun. Report-only; binds local ports.
bench-http: build
	LAVA_BIN="$(LAVA)" $${NODE_BIN:-node} bench/http/run-http-bench.mjs

# test-lava runs every oracle suite the platform supports through one entry point
# (scripts/run-oracles.sh) — the same script the Windows CI job runs against
# lava.exe. The per-suite test-*-lava targets above remain for granular runs.
test-lava: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-oracles.sh

fmt:
	$(ODIN) strip-semicolon cmd/lava
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point

# `rm` isn't a Windows command and can't take the $(RUNSCRIPT) prefix (bash would treat
# `rm` as a script), so invoke the shell explicitly: $(SHELL) is Git Bash on Windows and
# /bin/sh on Unix, and the quotes force make to route through it instead of direct-exec.
clean:
	"$(SHELL)" -c "rm -rf bin build pkg/runtime/picohttpparser/*.a pkg/runtime/picohttpparser/*.o"
