#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}

"$NODE_BIN" --version >/dev/null

for case_file in "$ROOT_DIR"/tests/runtime/eventloop/cases/*.js; do
	printf 'node %s\n' "${case_file#$ROOT_DIR/}"
	"$NODE_BIN" "$case_file"
done

printf '%s\n' 'event-loop oracle passed'

