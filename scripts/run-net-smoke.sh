#!/usr/bin/env sh
# node:net server smoke test (M1). The echo server (tests/runtime/net/server.js) is
# run under BOTH Node and Lava; the same Node client (client.js) hits each, and the
# two client outputs must be identical (server parity). Not part of the default
# `make test` because it binds a local TCP port (CI sandboxes may block it); run it
# explicitly with `make test-net-smoke`.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

SERVER="$ROOT_DIR/tests/runtime/net/server.js"
CLIENT="$ROOT_DIR/tests/runtime/net/client.js"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-net-smoke.XXXXXX")
SENTINEL='NET SMOKE OK'
SRV_PID=""

cleanup() {
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"$NODE_BIN" --version >/dev/null

# run_suite <client-out-file> <server launcher...> — start the echo server under the
# given runtime, wait for its READYPORT line, run the Node client against it, capture
# the client stdout, then stop the server.
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
		kill -0 "$SRV_PID" 2>/dev/null || break # server exited before listening
		i=$((i + 1))
		sleep 0.05
	done
	if [ -z "$port" ]; then
		printf '%s\n' 'net smoke FAILED: echo server never became reachable' >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi

	NET_PORT="$port" "$NODE_BIN" "$CLIENT" >"$out_file" 2>"$out_file.err" || true
	kill "$SRV_PID" 2>/dev/null || true
	wait "$SRV_PID" 2>/dev/null || true
	SRV_PID=""
}

run_suite "$TMP_DIR/node.out" "$NODE_BIN"
run_suite "$TMP_DIR/lava.out" "$LAVA_BIN" run

# Require the sentinel in BOTH client runs before trusting the diff — two clients that
# each crash early would otherwise match on empty stdout and false-pass.
for who in node lava; do
	if ! grep -q "$SENTINEL" "$TMP_DIR/$who.out"; then
		printf '%s\n' "net smoke FAILED: client did not reach '$SENTINEL' against the $who server (crashed or exited early)" >&2
		printf '%s\n' "--- $who client stdout ---" >&2
		cat "$TMP_DIR/$who.out" >&2 || true
		printf '%s\n' "--- $who client stderr ---" >&2
		cat "$TMP_DIR/$who.out.err" >&2 || true
		exit 1
	fi
done

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'net smoke passed (lava server matches node server)'
else
	printf '%s\n' 'net smoke FAILED: lava server output differs from node server' >&2
	exit 1
fi

# Client-socket parity (net.connect): one self-contained script — an echo server
# plus a net.connect client plus an ECONNREFUSED case — run under BOTH runtimes;
# the stdouts must match ('ok' sentinel guards against a double early-exit).
CONNECT="$ROOT_DIR/tests/runtime/net/connect-parity.js"
"$NODE_BIN" "$CONNECT" >"$TMP_DIR/node-connect.out" 2>&1 || true
"$LAVA_BIN" run "$CONNECT" >"$TMP_DIR/lava-connect.out" 2>&1 || true
for who in node lava; do
	if ! grep -q '^ok$' "$TMP_DIR/$who-connect.out"; then
		printf '%s\n' "net smoke FAILED: connect parity did not reach 'ok' under $who" >&2
		cat "$TMP_DIR/$who-connect.out" >&2 || true
		exit 1
	fi
done
if diff -u "$TMP_DIR/node-connect.out" "$TMP_DIR/lava-connect.out"; then
	printf '%s\n' 'net smoke passed (net.connect parity)'
else
	printf '%s\n' 'net smoke FAILED: net.connect parity output differs' >&2
	exit 1
fi
