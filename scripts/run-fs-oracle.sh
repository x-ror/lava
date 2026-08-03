#!/usr/bin/env sh
set -eu

# Runs every node:fs std test under tests/std/fs/cases. With RUN_LAVA=1 each case
# is compared against Node (exit status, stdout, stderr); otherwise it is a
# Node-only smoke run. New cases are picked up automatically by the glob.
#
# Unlike the POSIX-shaped tests/node-compat/cases/02-fs-path.js, these cases are
# cross-platform, so this runner also gates fs behavior on Windows CI (driven
# against build/lava.exe), where the node-compat suite does not run.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
RUN_LAVA=${RUN_LAVA:-0}
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-fs-oracle.XXXXXX")

. "$ROOT_DIR/scripts/lib/compare.sh"

trap 'rm -rf "$TMP_DIR"' EXIT

"$NODE_BIN" --version >/dev/null
node "$ROOT_DIR/scripts/agent-cycle/assert-case-counts.mjs" tests/std/fs/cases

for case_file in "$ROOT_DIR"/tests/std/fs/cases/*.js; do
	[ -f "$case_file" ] || continue
	run_case "$case_file"
done

printf '%s\n' 'fs oracle passed'
