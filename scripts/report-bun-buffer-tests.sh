#!/usr/bin/env sh
set -eu

# Run and report the ported Bun buffer compatibility cases under
# tests/node-compat/bun-buffer/ported.
#
# Each case is executed with Node (the oracle) to confirm it still encodes
# correct Node behavior. When a Lava binary is available (LAVA_BIN exists, or
# RUN_LAVA=1) every case is additionally compared Node-vs-Lava on exit status,
# stdout, and stderr — the same comparison the node-compat runner uses — so a
# behavioral regression in the Buffer implementation surfaces here.
#
# The exit code is non-zero if any case fails, making this safe to wire into CI
# or to run regularly while broadening Buffer coverage. New ported cases are
# picked up automatically by the glob.
#
#   scripts/report-bun-buffer-tests.sh             # Node oracle + Lava compare if built
#   RUN_LAVA=0 scripts/report-bun-buffer-tests.sh  # force Node-only
#   LAVA_BIN=/path/to/lava scripts/report-bun-buffer-tests.sh
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
PORTED_DIR="$ROOT_DIR/tests/node-compat/bun-buffer/ported"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-bun-buffer.XXXXXX")

# Compare against Lava when asked, or automatically when a Lava binary is built.
if [ "${RUN_LAVA:-}" = "" ]; then
	if [ -x "$LAVA_BIN" ]; then RUN_LAVA=1; else RUN_LAVA=0; fi
fi
export RUN_LAVA

. "$ROOT_DIR/scripts/lib/compare.sh"

trap 'rm -rf "$TMP_DIR"' EXIT

"$NODE_BIN" --version >/dev/null

if [ ! -d "$PORTED_DIR" ]; then
	printf '%s\n' "no ported buffer cases at ${PORTED_DIR#$ROOT_DIR/}"
	exit 1
fi

total=0
failed=0
for case_file in "$PORTED_DIR"/*.js "$PORTED_DIR"/*.mjs; do
	[ -f "$case_file" ] || continue
	total=$((total + 1))
	rel=${case_file#$ROOT_DIR/}
	if run_case "$case_file"; then
		printf 'ok   %s\n' "$rel"
	else
		printf 'FAIL %s\n' "$rel"
		failed=$((failed + 1))
	fi
done

printf '\n'
if [ "$RUN_LAVA" = "1" ]; then
	printf 'ported bun buffer cases: %d total, %d failed (node vs lava)\n' "$total" "$failed"
else
	printf 'ported bun buffer cases: %d total, %d failed (node only)\n' "$total" "$failed"
fi

[ "$failed" -eq 0 ]
