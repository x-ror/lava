#!/usr/bin/env bash
# Fetch the native dependencies that Windows cannot rely on as system packages.
# Outputs only ignored files under .deps/; build artifacts still go under build/.
set -euo pipefail
cd "$(dirname "$0")/.."

WEBKIT_TAG="${WEBKIT_TAG:-autobuild-9cb85a0716065c461bea14a0de9fe7139e5323aa}"

WEBKIT_TAG="$WEBKIT_TAG" "$BASH" scripts/fetch-webkit-windows.sh
"$BASH" scripts/fetch-sqlite-windows.sh
