#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}

run_node_case() {
	case_file=$1
	printf 'node %s\n' "${case_file#$ROOT_DIR/}"
	"$NODE_BIN" "$case_file"
}

run_lava_case() {
	case_file=$1
	printf 'lava %s\n' "${case_file#$ROOT_DIR/}"
	"$LAVA_BIN" run "$case_file"
}

"$NODE_BIN" --version >/dev/null

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.js; do
	run_node_case "$case_file"
	if [ "$RUN_LAVA" = "1" ]; then
		run_lava_case "$case_file"
	fi
done

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.mjs; do
	run_node_case "$case_file"
	if [ "$RUN_LAVA" = "1" ]; then
		run_lava_case "$case_file"
	fi
done

printf '%s\n' 'node compatibility oracle passed'

