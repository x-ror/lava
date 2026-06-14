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

# Optional HTTPS case: generate a self-signed cert for 127.0.0.1 and tell both
# runtimes to trust it (Node via NODE_EXTRA_CA_CERTS, Lava via OpenSSL's
# SSL_CERT_FILE). Skipped if the openssl CLI is unavailable; the HTTP cases
# still run and the suite stays green.
TLS_PORT=$((PORT + 1))
TLS_CERT="$TMP_DIR/cert.pem"
TLS_KEY="$TMP_DIR/key.pem"
FETCH_BASE_HTTPS=""
if command -v openssl >/dev/null 2>&1; then
	if openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_KEY" -out "$TLS_CERT" \
		-days 2 -subj "/CN=127.0.0.1" \
		-addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1; then
		FETCH_BASE_HTTPS="https://127.0.0.1:$TLS_PORT"
		export LAVA_TLS_CERT="$TLS_CERT" LAVA_TLS_KEY="$TLS_KEY" LAVA_TLS_PORT="$TLS_PORT"
	fi
fi

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

# Node trusts the self-signed CA via NODE_EXTRA_CA_CERTS; Lava's OpenSSL via
# SSL_CERT_FILE (honoured by SSL_CTX_set_default_verify_paths).
NODE_EXTRA_CA_CERTS="$TLS_CERT" \
	FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" FETCH_BASE_HTTPS="$FETCH_BASE_HTTPS" \
	"$NODE_BIN" "$CASE" >"$TMP_DIR/node.out" 2>&1 || true
SSL_CERT_FILE="$TLS_CERT" \
	FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" FETCH_BASE_HTTPS="$FETCH_BASE_HTTPS" \
	"$LAVA_BIN" run "$CASE" >"$TMP_DIR/lava.out" 2>&1 || true

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'fetch smoke passed (lava output matches node)'
else
	printf '%s\n' 'fetch smoke FAILED: lava output differs from node' >&2
	exit 1
fi
