ODIN ?= odin
LAVA ?= bin/lava
SOURCE ?= console.log('hello from Lava')
FILE ?=

.PHONY: help build run eval check check-cli check-runtime check-jsc check-native test test-lava test-report test-report-html api-surface vendor-bun-report bun-buffer-report test-compat test-compat-lava test-compat-lava-strict test-odin test-eventloop-odin test-sqlite-node test-eventloop-node test-eventloop-lava fmt clean

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make run FILE=app.js    Run a JavaScript file through lava'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate JavaScript source through lava'
	@printf '%s\n' '  make check              Type-check Odin packages'
	@printf '%s\n' '  make check-cli          Type-check the CLI package'
	@printf '%s\n' '  make check-runtime      Type-check runtime packages'
	@printf '%s\n' '  make check-jsc          Locate JavaScriptCore dev files (macOS framework or GTK) with install hints'
	@printf '%s\n' '  make check-native       Verify native build dependencies via pkg-config'
	@printf '%s\n' '  make test               Run Odin and Node compatibility tests'
	@printf '%s\n' '  make test-lava          Compare node-compat + event-loop suites through Lava (skips known gaps)'
	@printf '%s\n' '  make test-report        Run tests and write benchmark report'
	@printf '%s\n' '  make test-report-html   Write Node.js vs Lava HTML compatibility report'
	@printf '%s\n' '  make api-surface        Report Buffer/Crypto API surface differences vs Node'
	@printf '%s\n' '  make vendor-bun-report  Summarize vendored Bun node compatibility corpus'
	@printf '%s\n' '  make bun-buffer-report  List vendored Bun buffer tests and adapted ports'
	@printf '%s\n' '  make test-compat        Run all active Node compatibility tests with Node'
	@printf '%s\n' '  make test-compat-lava   Build and compare active compatibility tests through Lava, skipping known gaps'
	@printf '%s\n' '  make test-compat-lava-strict Build and compare active compatibility tests through Lava without skips'
	@printf '%s\n' '  make test-odin          Run Odin tests for the CLI package'
	@printf '%s\n' '  make test-eventloop-odin Run Odin event-loop core tests'
	@printf '%s\n' '  make test-sqlite-node   Run SQLite std tests with Node as oracle'
	@printf '%s\n' '  make test-eventloop-node Run event-loop ordering tests with Node as oracle'
	@printf '%s\n' '  make test-eventloop-lava Build and compare event-loop tests through Lava, skipping known gaps'
	@printf '%s\n' '  make fmt                Strip optional semicolons in Odin sources'
	@printf '%s\n' '  make clean              Remove build artifacts'
	@printf '%s\n' ''
	@printf '%s\n' 'Env knobs (for the node-compat and event-loop runners):'
	@printf '%s\n' '  RUN_LAVA=1              Compare each case Node-vs-Lava instead of Node-only'
	@printf '%s\n' '  SKIP_KNOWN_LAVA_GAPS=1  Skip paths listed in the matching known-lava-gaps.txt'
	@printf '%s\n' '  NODE_BIN=/path/to/node  Override the Node oracle binary'

build:
	./scripts/build.sh

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
	$(ODIN) check pkg/std/sqlite -no-entry-point

check-jsc:
	./scripts/check-jsc.sh

check-native:
	./scripts/check-native-deps.sh

test: test-odin test-eventloop-odin test-compat test-sqlite-node test-eventloop-node

test-report:
	./scripts/report-tests.sh

test-report-html: build
	./scripts/report-node-vs-lava.sh

api-surface: build
	./scripts/report-api-surface.sh

vendor-bun-report:
	./scripts/report-vendored-bun.sh

bun-buffer-report:
	./scripts/report-bun-buffer-tests.sh

test-compat:
	./scripts/run-node-compat-all.sh

test-compat-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-compat-lava-strict: build
	RUN_LAVA=1 LAVA_BIN="$(LAVA)" ./scripts/run-node-compat-all.sh

test-odin:
	$(ODIN) test cmd/lava -collection:lava=.

test-eventloop-odin:
	$(ODIN) test pkg/runtime/eventloop

test-sqlite-node:
	./scripts/run-sqlite-oracle.sh

test-eventloop-node:
	./scripts/run-eventloop-oracle.sh

test-eventloop-lava: build
	RUN_LAVA=1 SKIP_KNOWN_LAVA_GAPS=1 LAVA_BIN="$(LAVA)" ./scripts/run-eventloop-oracle.sh

test-lava: test-compat-lava test-eventloop-lava

fmt:
	$(ODIN) strip-semicolon cmd/lava
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point

clean:
	rm -rf bin build
