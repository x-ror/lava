#!/usr/bin/env sh
set -eu

# One entry point for the regular test suite. It runs Odin unit tests first, then
# the JS oracle suites. Set RUN_LAVA=1 to compare each oracle case through Lava;
# set INCLUDE_FETCH_SMOKE=1 to include the socket/TLS fetch smoke.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ODIN=${ODIN:-odin}
RUN_LAVA=${RUN_LAVA:-0}
INCLUDE_FETCH_SMOKE=${INCLUDE_FETCH_SMOKE:-0}

case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*) is_windows=1 ;;
	*) is_windows=0 ;;
esac

printf '%s\n' '== Odin tests =='
"$ODIN" test "$ROOT_DIR/cmd/lava" -collection:lava="$ROOT_DIR"
"$ODIN" test "$ROOT_DIR/pkg/runtime/eventloop"

if [ "$is_windows" = 1 ] && [ ! -f "$ROOT_DIR/build/sqlite3.lib" ]; then
	printf '%s\n' 'skip pkg/std/sqlite Odin link test (missing build/sqlite3.lib)'
else
	if [ "$is_windows" = 1 ]; then
		export LIB="$(cygpath -w "$ROOT_DIR/build");${LIB:-}"
	fi
	"$ODIN" test "$ROOT_DIR/pkg/std/sqlite"
fi

printf '%s\n' '== Oracle suites =='
if [ "$RUN_LAVA" = 1 ]; then
	RUN_LAVA=1 "$ROOT_DIR/scripts/run-oracles.sh"
else
	"$ROOT_DIR/scripts/run-node-compat-all.sh"
	"$ROOT_DIR/scripts/run-sqlite-oracle.sh"
	"$ROOT_DIR/scripts/run-fs-oracle.sh"
	"$ROOT_DIR/scripts/run-eventloop-oracle.sh"
fi

if [ "$INCLUDE_FETCH_SMOKE" = 1 ]; then
	printf '%s\n' '== Fetch smoke =='
	"$ROOT_DIR/scripts/run-fetch-smoke.sh"
fi

printf '%s\n' 'all tests passed'
