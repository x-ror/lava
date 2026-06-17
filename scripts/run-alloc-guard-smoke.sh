#!/usr/bin/env sh
# Allocation-guard smoke test (lava-only). Runs tests/runtime/alloc-guard/cap.js
# under lava with a tiny LAVA_MAX_BUFFER_BYTES ceiling and asserts:
#   1. lava exits 0 — the guard threw a *catchable* RangeError for each over-cap
#      request instead of letting JavaScriptCore abort the process (an abort would
#      surface as a non-zero / signal exit), and
#   2. the case's success marker reached stdout.
# Node does not honor LAVA_MAX_BUFFER_BYTES, so this is not part of the node-vs-lava
# corpus; it validates lava's own guard behavior. Honors LAVA_BIN (default bin/lava).
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
CASE="$ROOT_DIR/tests/runtime/alloc-guard/cap.js"
MARKER='alloc-guard cap enforced; process survived'

if [ ! -x "$LAVA_BIN" ] && [ ! -f "$LAVA_BIN" ]; then
	printf '%s\n' "skipping alloc-guard smoke (no lava binary at $LAVA_BIN; build first)"
	exit 0
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-alloc-guard.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT

# A 1 KiB ceiling: the case's over-cap sizes (~2 KiB) are far below what any machine
# could allocate, so a rejection can only come from the guard.
status=0
LAVA_MAX_BUFFER_BYTES=1024 "$LAVA_BIN" run "$CASE" >"$TMP_DIR/out" 2>"$TMP_DIR/err" || status=$?

if [ "$status" -ne 0 ]; then
	printf '%s\n' "alloc-guard smoke FAILED: lava exited $status (a non-zero/signal exit means the guard let JSC abort)" >&2
	printf '%s\n' '--- lava stdout ---' >&2
	cat "$TMP_DIR/out" >&2 || true
	printf '%s\n' '--- lava stderr ---' >&2
	cat "$TMP_DIR/err" >&2 || true
	exit 1
fi

if grep -q "$MARKER" "$TMP_DIR/out"; then
	printf '%s\n' 'alloc-guard smoke passed (cap enforced, process survived)'
else
	printf '%s\n' 'alloc-guard smoke FAILED: success marker not found in lava output' >&2
	printf '%s\n' '--- lava stdout ---' >&2
	cat "$TMP_DIR/out" >&2 || true
	printf '%s\n' '--- lava stderr ---' >&2
	cat "$TMP_DIR/err" >&2 || true
	exit 1
fi
