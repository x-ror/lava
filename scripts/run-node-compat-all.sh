#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
SKIP_KNOWN_LAVA_GAPS=${SKIP_KNOWN_LAVA_GAPS:-0}
TMP_DIR=${TMPDIR:-/tmp}/lava-node-compat-all.$$
KNOWN_GAPS_FILE="$ROOT_DIR/tests/node-compat/known-lava-gaps.txt"

. "$ROOT_DIR/scripts/lib/compare.sh"

"$NODE_BIN" --version >/dev/null

mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.js "$ROOT_DIR"/tests/node-compat/cases/*.mjs; do
	[ -f "$case_file" ] || continue
	run_case "$case_file"
done

for ported_dir in "$ROOT_DIR"/tests/node-compat/*/ported; do
	[ -d "$ported_dir" ] || continue
	for case_file in "$ported_dir"/*.js "$ported_dir"/*.mjs; do
		[ -f "$case_file" ] || continue
		run_case "$case_file"
	done
done

printf '%s\n' 'all active node compatibility tests passed'
