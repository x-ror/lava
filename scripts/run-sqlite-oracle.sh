#!/usr/bin/env sh
set -eu

# Runs every SQLite std test under tests/std/sqlite/cases with Node as the
# oracle. node:sqlite is not yet implemented in Lava, so there is no compare
# path here — new cases are picked up automatically by the glob.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}

"$NODE_BIN" --version >/dev/null

for case_file in "$ROOT_DIR"/tests/std/sqlite/cases/*.js; do
	[ -f "$case_file" ] || continue
	printf 'node %s\n' "${case_file#$ROOT_DIR/}"
	"$NODE_BIN" "$case_file"
done

printf '%s\n' 'sqlite oracle passed'
