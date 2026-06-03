#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
STRICT=${STRICT:-0}
TMP_DIR=${TMPDIR:-/tmp}/lava-api-surface.$$
PROBE="$ROOT_DIR/tests/node-compat/tools/api-surface.js"

mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

"$NODE_BIN" "$PROBE" >"$TMP_DIR/node.json"
"$LAVA_BIN" run "$PROBE" >"$TMP_DIR/lava.json"

if cmp -s "$TMP_DIR/node.json" "$TMP_DIR/lava.json"; then
	printf '%s\n' 'api surface matches Node'
	exit 0
fi

printf '%s\n' 'api surface differs from Node:'
diff -u "$TMP_DIR/node.json" "$TMP_DIR/lava.json" || true

if [ "$STRICT" = "1" ]; then
	exit 1
fi
