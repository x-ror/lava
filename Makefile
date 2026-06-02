ODIN ?= odin
LAVA ?= bin/lava
SOURCE ?= console.log('hello from Lava')
FILE ?=

# Set JSC_GTK6=1 to link against javascriptcoregtk-6.0 instead of the default 4.1
# (Linux only). The resulting -define flag is also exported to scripts/build.sh.
JSC_GTK6 ?= 0
ifeq ($(JSC_GTK6),1)
ODIN_DEFINES := -define:JSC_GTK6=true
else
ODIN_DEFINES :=
endif
export ODIN_DEFINES

.PHONY: help build run eval check check-cli check-runtime check-jsc check-native test test-report test-report-html test-odin test-eventloop-odin test-node test-node-lava test-sqlite-node test-eventloop-node fmt clean

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make run FILE=app.js    Run a JavaScript file through lava'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate JavaScript source through lava'
	@printf '%s\n' '  make check              Type-check Odin packages'
	@printf '%s\n' '  make check-cli          Type-check the CLI package'
	@printf '%s\n' '  make check-runtime      Type-check runtime packages'
	@printf '%s\n' '  make check-jsc          Check for JavaScriptCore development files'
	@printf '%s\n' '  make check-native       Check for JavaScriptCore development files'
	@printf '%s\n' '  make test               Run Odin and Node compatibility tests'
	@printf '%s\n' '  make test-report        Run tests and write benchmark report'
	@printf '%s\n' '  make test-report-html   Write Node.js vs Lava HTML compatibility report'
	@printf '%s\n' '  make test-odin          Run Odin tests for the CLI package'
	@printf '%s\n' '  make test-eventloop-odin Run Odin event-loop core tests'
	@printf '%s\n' '  make test-node          Run Node compatibility cases with Node as oracle'
	@printf '%s\n' '  make test-node-lava     Run Node compatibility cases through Lava too'
	@printf '%s\n' '  make test-sqlite-node   Run SQLite std tests with Node as oracle'
	@printf '%s\n' '  make test-eventloop-node Run event-loop ordering tests with Node as oracle'
	@printf '%s\n' '  make fmt                Strip optional semicolons in Odin sources'
	@printf '%s\n' '  make clean              Remove build artifacts'

build:
	./scripts/build.sh

run: build
	@test -n "$(FILE)" || { printf '%s\n' 'usage: make run FILE=app.js'; exit 2; }
	$(LAVA) run "$(FILE)"

eval: build
	$(LAVA) eval "$(SOURCE)"

check: check-cli check-runtime
	$(ODIN) check pkg/jsc -no-entry-point $(ODIN_DEFINES)

check-cli:
	$(ODIN) check cmd/lava -collection:lava=. $(ODIN_DEFINES)

check-runtime:
	$(ODIN) check pkg/runtime -no-entry-point -collection:lava=. $(ODIN_DEFINES)
	$(ODIN) check pkg/runtime/eventloop -no-entry-point
	$(ODIN) check pkg/std/sqlite -no-entry-point

check-jsc:
	./scripts/check-jsc.sh

check-native:
	./scripts/check-native-deps.sh

test: test-odin test-eventloop-odin test-node test-sqlite-node test-eventloop-node

test-report:
	./scripts/report-tests.sh

test-report-html: build
	./scripts/report-node-vs-lava.sh

test-odin:
	$(ODIN) test cmd/lava -collection:lava=. $(ODIN_DEFINES)

test-eventloop-odin:
	$(ODIN) test pkg/runtime/eventloop

test-node:
	./scripts/run-node-compat.sh

test-node-lava: build
	RUN_LAVA=1 ./scripts/run-node-compat.sh

test-sqlite-node:
	node tests/std/sqlite/cases/00-basic.js

test-eventloop-node:
	./scripts/run-eventloop-oracle.sh

fmt:
	$(ODIN) strip-semicolon cmd/lava
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point

clean:
	rm -rf bin build
