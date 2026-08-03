# Shared node-vs-lava comparison helpers, sourced by the compatibility runners.
#
# The caller must set these before sourcing and calling run_case:
#   ROOT_DIR              repo root (absolute)
#   NODE_BIN              node binary (oracle)
#   LAVA_BIN              lava binary
#   TMP_DIR               writable scratch dir (already created)
#   RUN_LAVA              "1" to compare node vs lava, else node-only
#
# Optional (run_case reads these defensively, so suites with no gaps need not
# set them — important under `set -u`):
#   SKIP_KNOWN_LAVA_GAPS  "1" to skip paths listed in KNOWN_GAPS_FILE (default 0)
#   KNOWN_GAPS_FILE       path to a gaps list (one relative path/line, # comments)

# Gate integrity (agent-cycle F1): a lava-vs-lava "oracle" is byte-identical by
# construction and must never count as a pass. Refuse when NODE_BIN is lava or
# identical to LAVA_BIN under a comparative run.
_lava_gate_integrity_check() {
	if [ "${RUN_LAVA:-0}" != "1" ]; then
		return 0
	fi
	_node_base=$(basename -- "$NODE_BIN" 2>/dev/null || basename "$NODE_BIN")
	case "$_node_base" in
	lava | lava.exe)
		printf '%s\n' "GATE INTEGRITY: NODE_BIN must be the Node oracle, not Lava (got $NODE_BIN)" >&2
		return 2
		;;
	esac
	if [ -n "${LAVA_BIN:-}" ] && [ "$NODE_BIN" = "$LAVA_BIN" ]; then
		printf '%s\n' "GATE INTEGRITY: NODE_BIN and LAVA_BIN are the same path ($NODE_BIN) — refuse lava-vs-lava" >&2
		return 2
	fi
	# Resolve both if they exist; catch NODE_BIN=./bin/lava via realpath.
	if command -v realpath >/dev/null 2>&1; then
		_nr=$(realpath "$NODE_BIN" 2>/dev/null || true)
		_lr=$(realpath "$LAVA_BIN" 2>/dev/null || true)
		if [ -n "$_nr" ] && [ -n "$_lr" ] && [ "$_nr" = "$_lr" ]; then
			printf '%s\n' "GATE INTEGRITY: NODE_BIN and LAVA_BIN resolve to the same file ($_nr)" >&2
			return 2
		fi
	fi
	return 0
}
_lava_gate_integrity_check || exit $?

run_node_case() {
	case_file=$1
	printf 'node %s\n' "${case_file#$ROOT_DIR/}"
	"$NODE_BIN" "$case_file"
}

# compare_case runs a case through both node and lava and fails on any
# difference in exit status, stdout, or stderr.
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

# run_case dispatches a single case: node-only, lava-compare, or skipped when it
# is a documented known gap under lava.
run_case() {
	case_file=$1
	rel_path=${case_file#$ROOT_DIR/}
	if [ "${RUN_LAVA:-0}" = "1" ] && [ "${SKIP_KNOWN_LAVA_GAPS:-0}" = "1" ] && [ -n "${KNOWN_GAPS_FILE:-}" ] && [ -f "$KNOWN_GAPS_FILE" ]; then
		if grep -v '^[[:space:]]*#' "$KNOWN_GAPS_FILE" | grep -qx "$rel_path"; then
			printf 'skip-known-gap %s\n' "$rel_path"
			return 0
		fi
	fi
	if [ "${RUN_LAVA:-0}" = "1" ]; then
		compare_case "$case_file"
	else
		run_node_case "$case_file"
	fi
}
