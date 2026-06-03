#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
SKIP_KNOWN_LAVA_GAPS=${SKIP_KNOWN_LAVA_GAPS:-0}
TMP_DIR=${TMPDIR:-/tmp}/lava-node-compat-all.$$
KNOWN_GAPS_FILE="$ROOT_DIR/tests/node-compat/known-lava-gaps.txt"

run_node_case() {
	case_file=$1
	printf 'node %s\n' "${case_file#$ROOT_DIR/}"
	"$NODE_BIN" "$case_file"
}

compare_case() {
	case_file=$1
	case_key=$(printf '%s' "${case_file#$ROOT_DIR/}" | tr '/.' '__')
	node_stdout="$TMP_DIR/$case_key.node.stdout"
	node_stderr="$TMP_DIR/$case_key.node.stderr"
	lava_stdout="$TMP_DIR/$case_key.lava.stdout"
	lava_stderr="$TMP_DIR/$case_key.lava.stderr"

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

run_case() {
	case_file=$1
	rel_path=${case_file#$ROOT_DIR/}
	if [ "$RUN_LAVA" = "1" ] && [ "$SKIP_KNOWN_LAVA_GAPS" = "1" ] && [ -f "$KNOWN_GAPS_FILE" ]; then
		if grep -v '^[[:space:]]*#' "$KNOWN_GAPS_FILE" | grep -qx "$rel_path"; then
			printf 'skip-known-gap %s\n' "$rel_path"
			return 0
		fi
	fi
	if [ "$RUN_LAVA" = "1" ]; then
		compare_case "$case_file"
	else
		run_node_case "$case_file"
	fi
}

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
