#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPORT_DIR=${REPORT_DIR:-"$ROOT_DIR/reports"}
REPORT_FILE=${REPORT_FILE:-"$REPORT_DIR/test-report.tsv"}
TMP_DIR=${TMPDIR:-/tmp}/lava-test-report.$$
TIME_BIN=${TIME_BIN:-/usr/bin/time}

mkdir -p "$REPORT_DIR" "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

printf 'suite\tstatus\texit_code\telapsed_sec\tmax_rss_kb\tcommand\n' >"$REPORT_FILE"

run_suite() {
	name=$1
	shift
	stdout_file="$TMP_DIR/$name.stdout"
	stderr_file="$TMP_DIR/$name.stderr"
	time_file="$TMP_DIR/$name.time"

	set +e
	"$TIME_BIN" -f 'elapsed_sec=%e max_rss_kb=%M' -o "$time_file" "$@" >"$stdout_file" 2>"$stderr_file"
	exit_code=$?
	set -e

	elapsed_sec=$(awk '{for (i = 1; i <= NF; i++) if ($i ~ /^elapsed_sec=/) {sub(/^elapsed_sec=/, "", $i); print $i}}' "$time_file")
	max_rss_kb=$(awk '{for (i = 1; i <= NF; i++) if ($i ~ /^max_rss_kb=/) {sub(/^max_rss_kb=/, "", $i); print $i}}' "$time_file")
	status=pass
	if [ "$exit_code" -ne 0 ]; then
		status=fail
	fi

	printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$status" "$exit_code" "$elapsed_sec" "$max_rss_kb" "$*" >>"$REPORT_FILE"
	printf '%-22s %4s  exit=%s  time=%ss  rss=%sKB\n' "$name" "$status" "$exit_code" "$elapsed_sec" "$max_rss_kb"

	if [ "$exit_code" -ne 0 ]; then
		printf '\n--- %s stderr ---\n' "$name"
		sed -n '1,120p' "$stderr_file"
		return "$exit_code"
	fi
}

printf 'Lava test benchmark report\n'
printf 'report: %s\n\n' "$REPORT_FILE"

run_suite odin-cli odin test "$ROOT_DIR/cmd/lava" -collection:lava="$ROOT_DIR"
run_suite odin-eventloop odin test "$ROOT_DIR/pkg/runtime/eventloop"
run_suite node-compat "$ROOT_DIR/scripts/run-node-compat-all.sh"
run_suite node-sqlite node "$ROOT_DIR/tests/std/sqlite/cases/00-basic.js"
run_suite node-eventloop "$ROOT_DIR/scripts/run-eventloop-oracle.sh"

printf '\n%s\n' 'benchmark report complete'
