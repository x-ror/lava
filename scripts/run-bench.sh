#!/usr/bin/env sh
set -eu

# Thin wrapper around bench/run.mjs, mirroring the oracle runners (scripts/run-*.sh) so
# the Makefile and CI invoke benchmarks the same way they invoke tests. All timing,
# parsing, and gating live in the Node orchestrator (portable, no shell JSON parsing).
#
# Honors NODE_BIN and LAVA_BIN like the oracle runners. Pass --gate to enforce the
# per-benchmark lava/node ratio caps in bench/thresholds.json (exit non-zero on breach);
# without it the run is report-only and always succeeds.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}
export NODE_BIN LAVA_BIN

"$NODE_BIN" --version >/dev/null

exec "$NODE_BIN" "$ROOT_DIR/bench/run.mjs" "$@"
