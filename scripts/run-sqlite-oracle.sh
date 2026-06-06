#!/usr/bin/env sh
set -eu

# Runs every SQLite std test under tests/std/sqlite/cases. With RUN_LAVA=1 each
# case is compared against Node (exit status, stdout, stderr); otherwise it is a
# Node-only smoke run. New cases are picked up automatically by the glob.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-sqlite-oracle.XXXXXX")

# node:sqlite is flagged experimental on Node 22 (the CI baseline), which prints
# an ExperimentalWarning to stderr that Node 24 and Lava do not. Suppress Node's
# warnings here so the stderr comparison reflects behavior, not version noise.
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-warnings"

trap 'rm -rf "$TMP_DIR"' EXIT

"$NODE_BIN" --version >/dev/null

compare_case() {
	case_file=$1
	case_key=$(printf '%s' "${case_file#$ROOT_DIR/}" | tr '/.' '__')
	node_out="$TMP_DIR/$case_key.node.out"
	node_err="$TMP_DIR/$case_key.node.err"
	lava_out="$TMP_DIR/$case_key.lava.out"
	lava_err="$TMP_DIR/$case_key.lava.err"

	set +e
	"$NODE_BIN" "$case_file" >"$node_out" 2>"$node_err"
	node_status=$?
	"$LAVA_BIN" run "$case_file" >"$lava_out" 2>"$lava_err"
	lava_status=$?
	set -e

	if [ "$node_status" -ne "$lava_status" ]; then
		printf 'exit mismatch for %s: node=%s lava=%s\n' "${case_file#$ROOT_DIR/}" "$node_status" "$lava_status"
		return 1
	fi
	if ! cmp -s "$node_out" "$lava_out"; then
		printf 'stdout mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_out" "$lava_out" || true
		return 1
	fi
	if ! cmp -s "$node_err" "$lava_err"; then
		printf 'stderr mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_err" "$lava_err" || true
		return 1
	fi
}

for case_file in "$ROOT_DIR"/tests/std/sqlite/cases/*.js; do
	[ -f "$case_file" ] || continue
	rel=${case_file#$ROOT_DIR/}
	if [ "$RUN_LAVA" = "1" ]; then
		printf 'compare %s\n' "$rel"
		compare_case "$case_file"
	else
		printf 'node %s\n' "$rel"
		"$NODE_BIN" "$case_file"
	fi
done

printf '%s\n' 'sqlite oracle passed'
