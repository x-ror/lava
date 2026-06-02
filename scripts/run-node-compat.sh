#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
TMP_DIR=${TMPDIR:-/tmp}/lava-node-compat.$$

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

compare_case() {
	case_file=$1
	case_name=$(basename "$case_file")
	node_stdout="$TMP_DIR/$case_name.node.stdout"
	node_stderr="$TMP_DIR/$case_name.node.stderr"
	lava_stdout="$TMP_DIR/$case_name.lava.stdout"
	lava_stderr="$TMP_DIR/$case_name.lava.stderr"

	set +e
	"$NODE_BIN" "$case_file" >"$node_stdout" 2>"$node_stderr"
	node_status=$?
	"$LAVA_BIN" run "$case_file" >"$lava_stdout" 2>"$lava_stderr"
	lava_status=$?
	set -e

	if [ "$node_status" -ne "$lava_status" ]; then
		printf 'exit mismatch for %s: node=%s lava=%s\n' "${case_file#$ROOT_DIR/}" "$node_status" "$lava_status"
		return 1
	fi

	if ! cmp -s "$node_stdout" "$lava_stdout"; then
		printf 'stdout mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_stdout" "$lava_stdout" || true
		return 1
	fi

	if ! cmp -s "$node_stderr" "$lava_stderr"; then
		printf 'stderr mismatch for %s\n' "${case_file#$ROOT_DIR/}"
		diff -u "$node_stderr" "$lava_stderr" || true
		return 1
	fi
}

"$NODE_BIN" --version >/dev/null

mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.js; do
	if [ "$RUN_LAVA" = "1" ]; then
		printf 'compare %s\n' "${case_file#$ROOT_DIR/}"
		compare_case "$case_file"
	else
		run_node_case "$case_file"
	fi
done

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.mjs; do
	if [ "$RUN_LAVA" = "1" ]; then
		printf 'compare %s\n' "${case_file#$ROOT_DIR/}"
		compare_case "$case_file"
	else
		run_node_case "$case_file"
	fi
done

printf '%s\n' 'node compatibility oracle passed'
