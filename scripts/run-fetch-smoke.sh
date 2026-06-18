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

# Native-path form for tools that don't understand MSYS/Cygwin paths. On the
# Windows CI runner this script runs under Git Bash, but the programs it hands
# cert paths to are native Win32 and reject "/tmp/..." paths: Node
# (NODE_EXTRA_CA_CERTS and server.js fs.readFileSync) and lava's OpenSSL
# (SSL_CERT_FILE). `cygpath -w -l` rewrites them to a long "C:\..." form; -l is
# required because the bare -w form can emit an 8.3 short name (RUNNER~1) that
# does not resolve when 8.3 generation is disabled on the volume. A no-op on
# Linux/macOS, where cygpath does not exist and the path is already native.
winpath() {
	if command -v cygpath >/dev/null 2>&1; then cygpath -w -l "$1"; else printf '%s' "$1"; fi
}

cleanup() {
	[ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

"$NODE_BIN" --version >/dev/null

# Optional HTTPS case: generate a self-signed cert for 127.0.0.1 and tell both
# runtimes to trust it (Node via NODE_EXTRA_CA_CERTS, Lava via SSL_CERT_FILE).
# Skipped if the openssl CLI is unavailable; the HTTP cases still run and the suite
# stays green. Runs on every platform: Lava honors SSL_CERT_FILE on Linux/Windows
# (OpenSSL) and on macOS (#143).
#
# extendedKeyUsage=serverAuth is required: Apple's TLS trust policy rejects a server
# cert without the serverAuth EKU (errSecInvalidExtendedKeyUsage), and OpenSSL
# accepts an EKU-bearing cert just the same — so it is needed on macOS and harmless
# elsewhere.
TLS_PORT=$((PORT + 1))
TLS_BADPORT=$((PORT + 2))
TLS_CERT="$TMP_DIR/cert.pem"
TLS_KEY="$TMP_DIR/key.pem"
TLS_BADCERT="$TMP_DIR/badcert.pem"
TLS_BADKEY="$TMP_DIR/badkey.pem"
TLS_CA="$TMP_DIR/ca.pem" # CA bundle trusting BOTH certs
FETCH_BASE_HTTPS=""
FETCH_BASE_HTTPS_BAD=""
if command -v openssl >/dev/null 2>&1; then
	# Good cert: SAN covers 127.0.0.1 — the positive HTTPS case connects to it.
	if openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_KEY" -out "$TLS_CERT" \
		-days 2 -subj "/CN=127.0.0.1" \
		-addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
		-addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1; then
		FETCH_BASE_HTTPS="https://127.0.0.1:$TLS_PORT"
		export LAVA_TLS_CERT="$(winpath "$TLS_CERT")" LAVA_TLS_KEY="$(winpath "$TLS_KEY")" LAVA_TLS_PORT="$TLS_PORT"
		cp "$TLS_CERT" "$TLS_CA"
		# Mismatched cert: trusted via the same CA bundle, but its SAN is a
		# different host — so connecting to 127.0.0.1 must fail hostname
		# verification (the negative case). Only enabled if it too generates.
		if openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS_BADKEY" -out "$TLS_BADCERT" \
			-days 2 -subj "/CN=example.com" \
			-addext "subjectAltName=DNS:example.com" \
			-addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1; then
			cat "$TLS_BADCERT" >>"$TLS_CA"
			FETCH_BASE_HTTPS_BAD="https://127.0.0.1:$TLS_BADPORT"
			export LAVA_TLS_BADCERT="$(winpath "$TLS_BADCERT")" LAVA_TLS_BADKEY="$(winpath "$TLS_BADKEY")" LAVA_TLS_BADPORT="$TLS_BADPORT"
		fi
	fi
fi

"$NODE_BIN" "$SERVER" "$PORT" &
SRV_PID=$!

# Wait for the origin to accept connections. A server that never binds (e.g.
# `listen EPERM` in a sandbox, or the port already in use) must FAIL the run, not
# silently fall through to a comparison of two empty outputs.
i=0
SERVER_UP=0
while [ "$i" -lt 50 ]; do
	if "$NODE_BIN" -e "require('net').connect($PORT,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then
		SERVER_UP=1
		break
	fi
	# Stop early if the server process has already exited — no listener is coming.
	if ! kill -0 "$SRV_PID" 2>/dev/null; then
		break
	fi
	i=$((i + 1))
	sleep 0.1
done
if [ "$SERVER_UP" -ne 1 ]; then
	printf '%s\n' 'fetch smoke FAILED: origin server never became reachable' >&2
	exit 1
fi

# Enable the IPv6 case only when the loopback listener is actually reachable
# (some CI sandboxes lack IPv6); both runtimes then see FETCH_BASE6 identically.
FETCH_BASE6=""
if "$NODE_BIN" -e "require('net').connect($PORT,'::1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; then
	FETCH_BASE6="http://[::1]:$PORT"
fi

# Both runtimes trust the self-signed CA bundle (good + mismatched certs): Node
# via NODE_EXTRA_CA_CERTS, Lava via SSL_CERT_FILE. Trusting both certs isolates the
# negative case to a hostname mismatch rather than an untrusted issuer. When no cert
# was generated the env vars point at a path that does not exist, which is harmless:
# the HTTPS cases are gated by FETCH_BASE_HTTPS being empty.
CA_FILE="$TLS_CA"
[ -f "$CA_FILE" ] || CA_FILE="$TLS_CERT"
CA_FILE_NATIVE="$(winpath "$CA_FILE")"
# Compare STDOUT only — the test's contract is the cases' console.log output.
# stderr is diagnostic noise that diverges per runtime/platform (e.g. Node's
# "Ignoring extra certs ..." CA-load warning on Windows) and must not fail the
# comparison; capture it separately so a genuine failure can still be inspected.
NODE_EXTRA_CA_CERTS="$CA_FILE_NATIVE" \
	FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" \
	FETCH_BASE_HTTPS="$FETCH_BASE_HTTPS" FETCH_BASE_HTTPS_BAD="$FETCH_BASE_HTTPS_BAD" \
	"$NODE_BIN" "$CASE" >"$TMP_DIR/node.out" 2>"$TMP_DIR/node.err" || true
SSL_CERT_FILE="$CA_FILE_NATIVE" \
	FETCH_BASE="http://127.0.0.1:$PORT" FETCH_BASE6="$FETCH_BASE6" \
	FETCH_BASE_HTTPS="$FETCH_BASE_HTTPS" FETCH_BASE_HTTPS_BAD="$FETCH_BASE_HTTPS_BAD" \
	"$LAVA_BIN" run "$CASE" >"$TMP_DIR/lava.out" 2>"$TMP_DIR/lava.err" || true

# Both runs end with a `FETCH SMOKE OK` sentinel (cases.js) only if they reached
# the end of the suite. Require it in BOTH outputs before trusting the diff —
# otherwise two processes that each crash before any assertion produce matching
# empty stdout and the diff would false-pass.
SENTINEL='FETCH SMOKE OK'
for who in node lava; do
	if ! grep -q "$SENTINEL" "$TMP_DIR/$who.out"; then
		printf '%s\n' "fetch smoke FAILED: $who run did not reach '$SENTINEL' (crashed or exited early)" >&2
		printf '%s\n' "--- $who stdout ---" >&2
		cat "$TMP_DIR/$who.out" >&2 || true
		printf '%s\n' "--- $who stderr ---" >&2
		cat "$TMP_DIR/$who.err" >&2 || true
		exit 1
	fi
done

if diff -u "$TMP_DIR/node.out" "$TMP_DIR/lava.out"; then
	printf '%s\n' 'fetch smoke passed (lava output matches node)'
else
	printf '%s\n' 'fetch smoke FAILED: lava output differs from node' >&2
	printf '%s\n' '--- node stderr ---' >&2
	cat "$TMP_DIR/node.err" >&2 || true
	printf '%s\n' '--- lava stderr ---' >&2
	cat "$TMP_DIR/lava.err" >&2 || true
	exit 1
fi
