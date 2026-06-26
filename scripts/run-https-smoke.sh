#!/usr/bin/env sh
# node:https server smoke test (M1). A self-signed cert is generated, the Lava HTTPS server
# fixture (tests/runtime/https/server.js) is started, and Lava's OWN TLS client (fetch) hits it —
# a closed lava-server ↔ lava-client loop — asserting byte-exact echo + large-body responses and
# the req.socket.encrypted flag. Run on BOTH backends (proactor default + LAVA_NET_FORCE_READINESS).
# Also runs the synchronous error-case assertions (bad/encrypted/mismatched PEM, rejected deferred
# options). Not part of `make test` because it binds a local port; run via `make test-https-smoke`.
#
# Skipped GREEN if the openssl CLI is unavailable (no cert can be made) — mirroring the fetch
# smoke's optional HTTPS case. CI has openssl, so the gate runs there.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
NODE_BIN=${NODE_BIN:-node}

HTTPS_DIR="$ROOT_DIR/tests/runtime/https"
SERVER="$HTTPS_DIR/server.js"
CLIENT="$HTTPS_DIR/client.js"
ERRCASES="$HTTPS_DIR/errcases.js"
KEEPALIVE_CLIENT="$HTTPS_DIR/keepalive-client.mjs"
RAW_CLIENT="$HTTPS_DIR/raw-client.mjs"
T5_SERVER="$HTTPS_DIR/t5-server.js"
T5_CLIENT="$HTTPS_DIR/t5-client.mjs"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-https-smoke.XXXXXX")
SRV_PID=""

cleanup() {
	[ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if ! command -v openssl >/dev/null 2>&1; then
	printf '%s\n' 'https smoke SKIPPED: openssl CLI not available (cannot generate a test cert)'
	exit 0
fi

CERT="$TMP_DIR/cert.pem"
KEY="$TMP_DIR/key.pem"
# Good cert: SAN covers 127.0.0.1 (the client connects there); serverAuth EKU is harmless on Linux.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" \
	-days 2 -subj "/CN=127.0.0.1" \
	-addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
	-addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1
# A mismatched keypair (for the key/cert-mismatch error case) and an encrypted key (for the
# "encrypted key must throw, not hang" case).
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP_DIR/otherkey.pem" -out "$TMP_DIR/othercert.pem" \
	-days 2 -subj "/CN=other" >/dev/null 2>&1
openssl rsa -in "$KEY" -aes256 -passout pass:secret -out "$TMP_DIR/enckey.pem" >/dev/null 2>&1

# Phase 1 — synchronous error cases (no server needed).
if TLS_DIR="$TMP_DIR" "$LAVA_BIN" run "$ERRCASES" >"$TMP_DIR/err.out" 2>&1 &&
	grep -q 'HTTPS ERRCASES OK' "$TMP_DIR/err.out"; then
	cat "$TMP_DIR/err.out"
else
	printf '%s\n' 'https smoke FAILED: error-case assertions failed' >&2
	cat "$TMP_DIR/err.out" >&2 || true
	exit 1
fi

# Phase 2 — server ↔ client over TLS, on each backend.
# run_backend <label> [server-env...] — start the Lava HTTPS server (optionally with extra env, e.g.
# LAVA_NET_FORCE_READINESS=1), wait for READYPORT, run the Lava fetch client (trusting the CA via
# SSL_CERT_FILE), and require the OK sentinel.
run_backend() {
	label=$1
	shift
	srv_out="$TMP_DIR/srv.out"
	: >"$srv_out"
	env "$@" TLS_KEY="$KEY" TLS_CERT="$CERT" "$LAVA_BIN" run "$SERVER" >"$srv_out" 2>&1 &
	SRV_PID=$!

	port=""
	i=0
	while [ "$i" -lt 200 ]; do
		port=$(sed -n 's/^READYPORT=//p' "$srv_out")
		[ -n "$port" ] && break
		kill -0 "$SRV_PID" 2>/dev/null || break
		i=$((i + 1))
		sleep 0.05
	done
	if [ -z "$port" ]; then
		printf '%s\n' "https smoke FAILED: server ($label) never became reachable" >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi

	out="$TMP_DIR/$label.out"
	PORT="$port" SSL_CERT_FILE="$CERT" "$LAVA_BIN" run "$CLIENT" >"$out" 2>&1 || true
	kill "$SRV_PID" 2>/dev/null || true
	wait "$SRV_PID" 2>/dev/null || true
	SRV_PID=""

	if grep -q 'HTTPS SMOKE OK' "$out"; then
		printf '%s\n' "https smoke phase ($label) passed"
	else
		printf '%s\n' "https smoke FAILED: client did not reach the OK sentinel on the $label backend" >&2
		printf '%s\n' "--- client output ---" >&2
		cat "$out" >&2 || true
		printf '%s\n' "--- server output ---" >&2
		grep -v '^READYPORT=' "$srv_out" >&2 || true
		exit 1
	fi
}

run_backend proactor
run_backend readiness LAVA_NET_FORCE_READINESS=1

# --- Node-driven phases (keep-alive, adversarial, lifecycle) -----------------
# These need a real keep-alive / raw-socket client, which Lava's fetch (Connection: close) can't be.
# Skipped GREEN if node is unavailable; CI has node (the http smoke uses it).
if ! "$NODE_BIN" --version >/dev/null 2>&1; then
	printf '%s\n' 'https smoke: node not found — skipping keep-alive/adversarial/lifecycle phases'
	printf '%s\n' 'https smoke passed (error cases + proactor + readiness; node phases skipped)'
	exit 0
fi

# start_https_server <out-file> [env...] -- launch a Lava HTTPS server (server.js unless overridden
# via SERVER_JS), wait for READYPORT, and set PORT. Leaves SRV_PID set for the caller to stop.
PORT=""
start_https_server() {
	srv_out=$1
	shift
	: >"$srv_out"
	env "$@" TLS_KEY="$KEY" TLS_CERT="$CERT" "$LAVA_BIN" run "${SERVER_JS:-$SERVER}" >"$srv_out" 2>&1 &
	SRV_PID=$!
	PORT=""
	i=0
	while [ "$i" -lt 200 ]; do
		PORT=$(sed -n 's/^READYPORT=//p' "$srv_out")
		[ -n "$PORT" ] && break
		kill -0 "$SRV_PID" 2>/dev/null || break
		i=$((i + 1))
		sleep 0.05
	done
	if [ -z "$PORT" ]; then
		printf '%s\n' "https smoke FAILED: server never became reachable" >&2
		cat "$srv_out" >&2 || true
		exit 1
	fi
}

stop_https_server() {
	kill "$SRV_PID" 2>/dev/null || true
	wait "$SRV_PID" 2>/dev/null || true
	SRV_PID=""
}

fail_phase() {
	printf '%s\n' "https smoke FAILED: $1" >&2
	printf '%s\n' '--- client output ---' >&2
	cat "$2" >&2 || true
	printf '%s\n' '--- server output ---' >&2
	grep -v '^READYPORT=' "$3" >&2 || true
	exit 1
}

# Phase 3 — keep-alive over a single TLS session (T1), both backends: the Node client reuses one
# socket for 3 requests (one handshake) and asserts each response is byte-correct.
keepalive_phase() {
	label=$1
	shift
	srv_out="$TMP_DIR/ka-$label.srv"
	cli_out="$TMP_DIR/ka-$label.cli"
	start_https_server "$srv_out" "$@"
	PORT="$PORT" TLS_CERT="$CERT" "$NODE_BIN" "$KEEPALIVE_CLIENT" >"$cli_out" 2>&1 || true
	stop_https_server
	grep -q 'KEEPALIVE OK' "$cli_out" || fail_phase "keep-alive ($label) did not reuse one TLS session" "$cli_out" "$srv_out"
	printf '%s\n' "https smoke keep-alive ($label) passed (1 session, 3 requests)"
}

keepalive_phase proactor
keepalive_phase readiness LAVA_NET_FORCE_READINESS=1

# Phase 3b — graceful close fires the server's net.Socket 'end' exactly once (T2), both backends
# (the M2 readiness double-'end' regression). Self-contained Node driver: it spawns the Lava server,
# does a raw tls.connect + close_notify, and counts 'end' from the server's stdout after exit.
graceful_phase() {
	label=$1
	shift
	out="$TMP_DIR/grace-$label.out"
	env "$@" LAVA_BIN="$LAVA_BIN" TLS_DIR="$TMP_DIR" "$NODE_BIN" "$HTTPS_DIR/graceful-end-test.mjs" >"$out" 2>&1 || true
	if grep -q 'GRACEFUL-END OK' "$out"; then
		printf '%s\n' "https smoke graceful-close ($label) passed (single 'end')"
	else
		printf '%s\n' "https smoke FAILED: graceful-close 'end' check ($label)" >&2
		cat "$out" >&2 || true
		exit 1
	fi
}

graceful_phase proactor
graceful_phase readiness LAVA_NET_FORCE_READINESS=1

# Phase 4 — adversarial: a stalled handshake is reaped by the timeout (T3, short timeout), and
# non-TLS garbage to the TLS port fails the handshake and closes without hanging (T4).
raw_phase() {
	mode=$1
	shift
	srv_out="$TMP_DIR/raw-$mode.srv"
	cli_out="$TMP_DIR/raw-$mode.cli"
	start_https_server "$srv_out" "$@"
	PORT="$PORT" "$NODE_BIN" "$RAW_CLIENT" "$mode" >"$cli_out" 2>&1 || true
	stop_https_server
	grep -qi "$mode OK" "$cli_out" || fail_phase "adversarial '$mode' did not close cleanly" "$cli_out" "$srv_out"
	printf '%s\n' "https smoke adversarial ($mode) passed"
}

raw_phase timeout LAVA_TLS_HANDSHAKE_TIMEOUT_MS=500
raw_phase garbage

# Phase 5 — server.close() while a TLS connection is live frees the SSL_CTX with a per-conn SSL
# still in use; the second request on the same session must still succeed (T5, refcount-safe).
t5_phase() {
	srv_out="$TMP_DIR/t5.srv"
	cli_out="$TMP_DIR/t5.cli"
	SERVER_JS="$T5_SERVER" start_https_server "$srv_out"
	PORT="$PORT" TLS_CERT="$CERT" "$NODE_BIN" "$T5_CLIENT" >"$cli_out" 2>&1 || true
	sleep 0.3 # let the server's 'close' fire after the live connection ends
	stop_https_server
	grep -q 'CLOSE-LIVE OK' "$cli_out" || fail_phase "request-after-close-on-live-session failed" "$cli_out" "$srv_out"
	grep -q 'CLOSED-CLEAN' "$srv_out" || fail_phase "server.close() did not complete cleanly with a live conn" "$cli_out" "$srv_out"
	printf '%s\n' 'https smoke lifecycle (server.close with a live TLS conn) passed'
}

t5_phase

printf '%s\n' 'https smoke passed (errors + proactor + readiness + keep-alive + adversarial + lifecycle)'
