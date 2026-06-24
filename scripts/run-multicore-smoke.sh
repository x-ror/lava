#!/usr/bin/env sh
# Multi-core workers smoke (Slice 3a). Exercises the LAVA_WORKERS end-to-end behaviour that unit tests
# can't: worker-count validation, N workers sharing a port via SO_REUSEPORT (load distribution),
# listen(0) rejection under multi-worker, and graceful SIGTERM drain. Binds a local TCP port, so it is
# not part of the default `make test`; run it with `make test-multicore-smoke`. Linux only (multi-worker
# is Linux-only); a no-op success elsewhere.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

case "$(uname -s)" in
Linux) ;;
*)
	echo "multicore smoke skipped (Linux only)"
	exit 0
	;;
esac

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lava-multicore-smoke.XXXXXX")
SUP_PID=""
cleanup() {
	[ -n "$SUP_PID" ] && kill -9 "$SUP_PID" 2>/dev/null || true
	rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
	echo "MULTICORE SMOKE FAIL: $1" >&2
	exit 1
}

PORT=$((20000 + $$ % 20000))

# --- 1) worker-count validation fails fast (exit 2) on invalid values --------------------------------
cat >"$TMP_DIR/noop.js" <<'EOF'
console.log("ok");
EOF
for bad in 0 -1 abc 99999; do
	if LAVA_WORKERS="$bad" "$LAVA_BIN" run "$TMP_DIR/noop.js" >/dev/null 2>&1; then
		fail "LAVA_WORKERS=$bad should have exited non-zero"
	fi
done
echo "  ok: invalid LAVA_WORKERS values rejected (fail-fast)"

# --- 2) non-server multi-worker: every worker runs the script, all exit cleanly ----------------------
runs=$(LAVA_WORKERS=4 "$LAVA_BIN" run "$TMP_DIR/noop.js" 2>/dev/null | grep -c "ok") || true
[ "$runs" = "4" ] || fail "expected 4 worker runs, got $runs"
echo "  ok: LAVA_WORKERS=4 ran the script on 4 workers"

# --- 3) listen(0) is rejected under multi-worker (startup abort) -------------------------------------
cat >"$TMP_DIR/srv0.js" <<'EOF'
require('http').createServer((req, res) => res.end('x')).listen(0, () => {});
EOF
if LAVA_WORKERS=2 "$LAVA_BIN" run "$TMP_DIR/srv0.js" >"$TMP_DIR/srv0.out" 2>&1; then
	fail "listen(0) under multi-worker should abort startup"
fi
grep -q "explicit port is required" "$TMP_DIR/srv0.out" || fail "listen(0) error message missing"
echo "  ok: listen(0) rejected under multi-worker"

# --- 4) multi-worker server: 4 workers share the port (SO_REUSEPORT), load distributes ---------------
cat >"$TMP_DIR/srv.js" <<EOF
const http = require('http');
// pid is shared across thread-workers, so a per-worker random id identifies which worker replied.
const wid = Math.floor(Math.random() * 1e9).toString(36);
http.createServer((req, res) => res.end(wid)).listen($PORT, () => {});
EOF
LAVA_WORKERS=4 "$LAVA_BIN" run "$TMP_DIR/srv.js" >"$TMP_DIR/srv.out" 2>&1 &
SUP_PID=$!

ready=0
i=0
while [ "$i" -lt 100 ]; do
	if curl -s --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
		ready=1
		break
	fi
	kill -0 "$SUP_PID" 2>/dev/null || fail "server exited during startup: $(cat "$TMP_DIR/srv.out")"
	i=$((i + 1))
	sleep 0.1
done
[ "$ready" = "1" ] || fail "server did not become ready"

: >"$TMP_DIR/ids"
j=0
while [ "$j" -lt 80 ]; do
	curl -s --max-time 1 "http://127.0.0.1:$PORT/" >>"$TMP_DIR/ids" 2>/dev/null || true
	echo >>"$TMP_DIR/ids"
	j=$((j + 1))
done
distinct=$(sort "$TMP_DIR/ids" | grep -c . | head -1) || true
distinct=$(sort -u "$TMP_DIR/ids" | grep -c .) || true
[ "$distinct" -ge 2 ] || fail "expected load spread across >=2 workers, saw $distinct distinct id(s)"
echo "  ok: $distinct workers shared :$PORT and served requests (SO_REUSEPORT distribution)"

# --- 5) SIGTERM drains and exits gracefully within a bounded time ------------------------------------
kill -TERM "$SUP_PID"
k=0
while [ "$k" -lt 50 ]; do
	kill -0 "$SUP_PID" 2>/dev/null || break
	k=$((k + 1))
	sleep 0.2
done
if kill -0 "$SUP_PID" 2>/dev/null; then
	kill -9 "$SUP_PID" 2>/dev/null || true
	fail "server did not exit within ~10s of SIGTERM (drain hang)"
fi
wait "$SUP_PID" 2>/dev/null || true
SUP_PID=""
echo "  ok: SIGTERM drained and exited gracefully"

echo "MULTICORE SMOKE OK"
