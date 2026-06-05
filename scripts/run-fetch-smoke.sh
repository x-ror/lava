#!/usr/bin/env sh
# Fetch transport smoke test: start a Node origin server, then run the same
# cases under Node and under Lava and require identical output. Not part of the
# default `make test` because it binds a local TCP port (CI sandboxes may block
# it); run it explicitly with `make test-fetch-smoke`.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
PORT=${FETCH_TEST_PORT:-8799}

SERVER="$ROOT_DIR/tests/runtime/fetch/server.js"
CASE="$ROOT_DIR/tests/runtime/fetch/cases.js"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-fetch-smoke.XXXXXX")

cleanup() {
	[ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"$NODE_BIN" --version >/dev/null

"$NODE_BIN" "$SERVER" "$PORT" &
SRV_PID=$!

# Wait for the origin to accept connections.
i=0
while [ "$i" -lt 50 ]; do
	if "$NODE_BIN" -e "require('net').connect($PORT,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then
		break
	fi
	i=$((i + 1))
	sleep 0.1
done

# Enable the IPv6 case only when the loopback listener is actually reachable
# (some CI sandboxes lack IPv6); both runtimes then see FETCH_BASE6 identically.
FETCH_BASE6=""
if "$NODE_BIN" -e "require('net').connect($PORT,'::1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then
	FETCH_BASE6="http://[::1]:$PORT"
fi

FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" "$NODE_BIN" "$CASE" >"$TMP_DIR/node.out" 2>&1 || true
FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" "$LAVA_BIN" run "$CASE" >"$TMP_DIR/lava.out" 2>&1 || true

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'fetch smoke passed (lava output matches node)'
else
	printf '%s\n' 'fetch smoke FAILED: lava output differs from node' >&2
	exit 1
fi
