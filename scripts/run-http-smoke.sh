#!/usr/bin/env sh
# node:http server smoke test (M2). The echo server (tests/runtime/http/server.js) is
# run under BOTH Node and Lava; the same Node client (client.js) hits each, and the
# deterministic response fields it prints must be identical (server parity). Not part of
# the default `make test` because it binds a local TCP port; run with `make test-http-smoke`.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

SERVER="$ROOT_DIR/tests/runtime/http/server.js"
CLIENT="$ROOT_DIR/tests/runtime/http/client.js"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-http-smoke.XXXXXX")
SENTINEL='HTTP SMOKE OK'
SRV_PID=""

cleanup() {
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"$NODE_BIN" --version >/dev/null

# run_suite <client-out-file> <server launcher...> — start the echo server under the
# given runtime, wait for its READYPORT line, run the Node client against it, capture the
# client stdout, then stop the server.
run_suite() {
	out_file=$1
	shift
	srv_out="$TMP_DIR/srv.out"
	: >"$srv_out"
	"$@" "$SERVER" >"$srv_out" 2>&1 &
	SRV_PID=$!

	port=""
	i=0
	while [ "$i" -lt 100 ]; do
		port=$(sed -n 's/^READYPORT=//p' "$srv_out")
		[ -n "$port" ] && break
		kill -0 "$SRV_PID" 2>/dev/null || break
		i=$((i + 1))
		sleep 0.05
	done
	if [ -z "$port" ]; then
		printf '%s\n' 'http smoke FAILED: echo server never became reachable' >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi

	HTTP_PORT="$port" "$NODE_BIN" "$CLIENT" >"$out_file" 2>"$out_file.err" || true
	kill "$SRV_PID" 2>/dev/null || true
	wait "$SRV_PID" 2>/dev/null || true
	SRV_PID=""
}

run_suite "$TMP_DIR/node.out" "$NODE_BIN"
run_suite "$TMP_DIR/lava.out" "$LAVA_BIN" run

for who in node lava; do
	if ! grep -q "$SENTINEL" "$TMP_DIR/$who.out"; then
		printf '%s\n' "http smoke FAILED: client did not reach '$SENTINEL' against the $who server (crashed or exited early)" >&2
		printf '%s\n' "--- $who client stdout ---" >&2
		cat "$TMP_DIR/$who.out" >&2 || true
		printf '%s\n' "--- $who client stderr ---" >&2
		cat "$TMP_DIR/$who.out.err" >&2 || true
		exit 1
	fi
done

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'http smoke passed (lava server matches node server)'
else
	printf '%s\n' 'http smoke FAILED: lava server output differs from node server' >&2
	exit 1
fi
