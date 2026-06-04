#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
SKIP_KNOWN_LAVA_GAPS=${SKIP_KNOWN_LAVA_GAPS:-0}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-eventloop.XXXXXX")
KNOWN_GAPS_FILE="$ROOT_DIR/tests/runtime/eventloop/known-lava-gaps.txt"

. "$ROOT_DIR/scripts/lib/compare.sh"

"$NODE_BIN" --version >/dev/null

trap 'rm -rf "$TMP_DIR"' EXIT

for case_file in "$ROOT_DIR"/tests/runtime/eventloop/cases/*.js; do
	[ -f "$case_file" ] || continue
	run_case "$case_file"
done

printf '%s\n' 'event-loop oracle passed'
