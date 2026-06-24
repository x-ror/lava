#!/usr/bin/env sh
# MSG_ZEROCOPY send smoke (Slice 3b). Exercises the SEND_ZC path end-to-end that unit tests can't: a
# large (>= NET_ZC_THRESHOLD) response body is submitted via SEND_ZC, and the two-CQE buffer-lifetime
# state machine must deliver it BYTE-EXACT (a premature buffer free/rotate would corrupt the body — the
# kernel-side UAF this slice guards against). Also checks a small body (the plain copy-SEND path below
# the threshold) still works. Binds a local TCP port, so it is not part of the default `make test`; run
# it with `make test-zerocopy-smoke`. Linux only (the proactor is Linux-only); a no-op success elsewhere.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

case "$(uname -s)" in
Linux) ;;
*)
	echo "zerocopy smoke skipped (Linux only)"
	exit 0
	;;
esac

command -v curl >/dev/null 2>&1 || { echo "zerocopy smoke skipped (curl not found)"; exit 0; }

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-zerocopy-smoke.XXXXXX")
SRV_PID=""
cleanup() {
	[ -n "$SRV_PID" ] && kill -9 "$SRV_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
	echo "ZEROCOPY SMOKE FAIL: $1" >&2
	exit 1
}

PORT=$(( (RANDOM % 20000) + 20000 ))

# Server: a small body (plain path) at /small and a 256 KiB deterministic body (ZC path, > the 32 KiB
# threshold) at /big. The body is `i & 0xff` so corruption from a mis-managed pinned buffer is detectable.
cat >"$TMP_DIR/srv.js" <<EOF
const http = require('http');
const big = Buffer.alloc(256 * 1024, 0);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
const small = Buffer.from('ok');
http.createServer((req, res) => {
  const b = req.url === '/big' ? big : small;
  res.setHeader('Content-Length', b.length);
  res.end(b);
}).listen($PORT, () => console.log('READY'));
EOF

"$LAVA_BIN" run "$TMP_DIR/srv.js" >"$TMP_DIR/srv.log" 2>&1 &
SRV_PID=$!
i=0
while [ "$i" -lt 50 ]; do
	grep -q READY "$TMP_DIR/srv.log" 2>/dev/null && break
	kill -0 "$SRV_PID" 2>/dev/null || fail "server exited during startup: $(cat "$TMP_DIR/srv.log")"
	i=$((i + 1))
	sleep 0.1
done
grep -q READY "$TMP_DIR/srv.log" 2>/dev/null || fail "server did not become ready"

# Expected sha256 of the 256 KiB body, computed independently with node.
EXP=$("$LAVA_BIN" run /dev/stdin <<'EOF' 2>/dev/null || true
const b = Buffer.alloc(256 * 1024, 0);
for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
console.log(require('crypto').createHash('sha256').update(b).digest('hex'));
EOF
)
[ -n "$EXP" ] || fail "could not compute the expected checksum"

# Hit the large (ZC) body repeatedly; every response must be byte-exact (256 KiB + matching sha256).
n=24
for k in $(seq 1 "$n"); do
	curl -s --max-time 5 "http://127.0.0.1:$PORT/big" >"$TMP_DIR/got.$k.bin" 2>/dev/null || fail "request $k failed"
	sz=$(wc -c <"$TMP_DIR/got.$k.bin")
	[ "$sz" = "262144" ] || fail "request $k: expected 262144 bytes, got $sz (buffer-lifetime corruption?)"
	got=$(sha256sum <"$TMP_DIR/got.$k.bin" | cut -d' ' -f1)
	[ "$got" = "$EXP" ] || fail "request $k: sha256 mismatch — ZC body corrupted"
done
echo "  ok: $n large-body (SEND_ZC) responses byte-exact (256 KiB, sha256 match)"

# The plain copy-SEND path (below threshold) still serves correctly.
small=$(curl -s --max-time 5 "http://127.0.0.1:$PORT/small" 2>/dev/null || true)
[ "$small" = "ok" ] || fail "small-body (plain path) response wrong: '$small'"
echo "  ok: small-body (plain copy-SEND, below threshold) serves correctly"

kill -9 "$SRV_PID" 2>/dev/null || true
wait "$SRV_PID" 2>/dev/null || true
SRV_PID=""
echo "ZEROCOPY SMOKE OK"
