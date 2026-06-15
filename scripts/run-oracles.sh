#!/usr/bin/env sh
set -eu

# Run every node-vs-lava oracle suite this platform supports against LAVA_BIN.
# A single entry point so each CI job (and `make test-lava`) covers every module
# with one command; a new cross-platform suite added here is picked up everywhere.
#
# Platform coverage:
#   event-loop, node:fs : all platforms (pure-JS / cross-platform behavior).
#   node:sqlite         : all platforms — Linux/macOS link the system libsqlite3,
#                         Windows links the statically-built sqlite3.lib from the
#                         cached amalgamation (see SQLITE_AVAILABLE in
#                         pkg/std/sqlite/sqlite.odin and scripts/build-sqlite-windows.sh).
#   node-compat suite   : Linux/macOS only — it includes POSIX path cases
#                         (tests/node-compat/cases/02-fs-path.js).
#
# Honors RUN_LAVA, LAVA_BIN and NODE_BIN (passed through to each sub-runner).
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
RUN_LAVA=${RUN_LAVA:-1}
export RUN_LAVA

case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*) cross_platform_only=1 ;;
	*) cross_platform_only=0 ;;
esac

SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-eventloop-oracle.sh"
"$ROOT_DIR/scripts/run-fs-oracle.sh"
"$ROOT_DIR/scripts/run-sqlite-oracle.sh"

if [ "$cross_platform_only" = 0 ]; then
	SKIP_KNOWN_LAVA_GAPS=1 "$ROOT_DIR/scripts/run-node-compat-all.sh"
else
	printf '%s\n' 'skipping node-compat suite (POSIX-path-shaped; not supported on this platform)'
fi

printf '%s\n' 'all supported oracle suites passed'
