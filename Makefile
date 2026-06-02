ODIN ?= odin
LAVA ?= bin/lava
SOURCE ?= console.log('hello from Lava')
FILE ?=

.PHONY: help build run eval check check-cli check-jsc test test-odin test-node test-node-lava fmt clean

help:
	@printf '%s\n' 'Lava commands'
	@printf '%s\n' ''
	@printf '%s\n' '  make build              Build the lava CLI'
	@printf '%s\n' '  make run FILE=app.js    Run a JavaScript file through lava'
	@printf '%s\n' '  make eval SOURCE=...    Evaluate JavaScript source through lava'
	@printf '%s\n' '  make check              Type-check Odin packages'
	@printf '%s\n' '  make check-cli          Type-check the CLI package'
	@printf '%s\n' '  make check-jsc          Check for JavaScriptCore development files'
	@printf '%s\n' '  make test               Run Odin and Node compatibility tests'
	@printf '%s\n' '  make test-odin          Run Odin tests for the CLI package'
	@printf '%s\n' '  make test-node          Run Node compatibility cases with Node as oracle'
	@printf '%s\n' '  make test-node-lava     Run Node compatibility cases through Lava too'
	@printf '%s\n' '  make fmt                Strip optional semicolons in Odin sources'
	@printf '%s\n' '  make clean              Remove build artifacts'

build:
	./scripts/build.sh

run: build
	@test -n "$(FILE)" || { printf '%s\n' 'usage: make run FILE=app.js'; exit 2; }
	$(LAVA) run "$(FILE)"

eval: build
	$(LAVA) eval "$(SOURCE)"

check: check-cli
	$(ODIN) check pkg/jsc -no-entry-point

check-cli:
	$(ODIN) check cmd/lava

check-jsc:
	./scripts/check-jsc.sh

test: test-odin test-node

test-odin:
	$(ODIN) test cmd/lava

test-node:
	./scripts/run-node-compat.sh

test-node-lava: build
	RUN_LAVA=1 ./scripts/run-node-compat.sh

fmt:
	$(ODIN) strip-semicolon cmd/lava
	$(ODIN) strip-semicolon pkg/jsc -no-entry-point

clean:
	rm -rf bin build
