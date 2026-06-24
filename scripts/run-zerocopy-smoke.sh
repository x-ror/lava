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

# Server: a small body (plain path) at /small and a 256 KiB deterministic body (ZC path, > the 32 KiB
# threshold) at /big. The body is `i & 0xff` so corruption from a mis-managed pinned buffer is detectable.
# It binds port 0 (kernel-assigned) and prints "READY <port>" — POSIX-safe (no $RANDOM, which is unset
# under dash/sh) and collision-free, vs hardcoding a port.
cat >"$TMP_DIR/srv.js" <<'EOF'
const http = require('http');
const big = Buffer.alloc(256 * 1024, 0);
for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
const small = Buffer.from('ok');
const srv = http.createServer((req, res) => {
  const b = req.url === '/big' ? big : small;
  res.setHeader('Content-Length', b.length);
  res.end(b);
});
srv.listen(0, () => console.log('READY ' + srv.address().port));
EOF

# LAVA_ZC_STATS makes the runtime print "LAVA_ZC: zc_ok=<0|1>" and "LAVA_ZC: SEND_ZC engaged" to stderr
# (captured below) so a green run can be distinguished from a silent plain-path fallback (M3).
LAVA_ZC_STATS=1 "$LAVA_BIN" run "$TMP_DIR/srv.js" >"$TMP_DIR/srv.log" 2>&1 &
SRV_PID=$!
PORT=""
i=0
while [ "$i" -lt 50 ]; do
	PORT=$(sed -n 's/^READY \([0-9][0-9]*\)$/\1/p' "$TMP_DIR/srv.log" 2>/dev/null | head -1)
	[ -n "$PORT" ] && break
	kill -0 "$SRV_PID" 2>/dev/null || fail "server exited during startup: $(cat "$TMP_DIR/srv.log")"
	i=$((i + 1))
	sleep 0.1
done
[ -n "$PORT" ] || fail "server did not become ready (no 'READY <port>' in $(cat "$TMP_DIR/srv.log"))"

# Expected sha256 of the 256 KiB body, computed with an INDEPENDENT tool (node, else python3) — a bug in
# lava's own Buffer then can't make the served body and the expected hash wrong in the same way. Falls
# back to lava only if neither is present (a self-consistency check then, not an independent oracle).
EXP=""
if command -v node >/dev/null 2>&1; then
	EXP=$(node -e 'const b=Buffer.alloc(262144);for(let i=0;i<b.length;i++)b[i]=i&0xff;console.log(require("crypto").createHash("sha256").update(b).digest("hex"))' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
	EXP=$(python3 -c 'import hashlib;print(hashlib.sha256(bytes(i&0xff for i in range(262144))).hexdigest())' 2>/dev/null || true)
fi
if [ -z "$EXP" ]; then
	EXP=$("$LAVA_BIN" run /dev/stdin <<'EOF' 2>/dev/null || true
const b = Buffer.alloc(256 * 1024, 0);
for (let i = 0; i < b.length; i++) b[i] = i & 0xff;
console.log(require('crypto').createHash('sha256').update(b).digest('hex'));
EOF
)
fi
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

# M3: prove the SEND_ZC path was actually exercised — a byte-exact body alone can't tell a real ZC run
# from a silent plain-path fallback (zc_ok=false on this kernel, or an -EINVAL/-EOPNOTSUPP fallback).
# When ZC is forced off (the proactor is bypassed entirely under LAVA_NET_FORCE_READINESS), skip the
# assertion — the run is intentionally plain — but still require the body was byte-exact (checked above).
if [ -n "${LAVA_NET_FORCE_READINESS:-}" ]; then
	echo "  ok: forced-readiness pass — large body served byte-exact with the proactor (and ZC) bypassed"
elif grep -q "LAVA_ZC: zc_ok=1" "$TMP_DIR/srv.log" 2>/dev/null; then
	grep -q "LAVA_ZC: SEND_ZC engaged" "$TMP_DIR/srv.log" 2>/dev/null \
		|| fail "kernel reports zc_ok=1 but SEND_ZC never engaged — the gate would have passed on the plain path"
	echo "  ok: SEND_ZC path confirmed exercised (zc_ok=1 + engaged)"
else
	echo "  note: SEND_ZC unavailable on this kernel (zc_ok=0) — large body served via plain copy-SEND, byte-exact"
fi

kill -9 "$SRV_PID" 2>/dev/null || true
wait "$SRV_PID" 2>/dev/null || true
SRV_PID=""
echo "ZEROCOPY SMOKE OK"
