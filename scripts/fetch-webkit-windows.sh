#!/usr/bin/env bash
# Download + extract a prebuilt JavaScriptCore for Windows so the Lava CLI can be
# linked there (issue #36). We use the Bun project's WebKit fork, which publishes
# redistributable Windows build archives that ship the JavaScriptCore C API
# headers (including JSContextRefPrivate.h, which our bindings need) plus the
# static libs: JavaScriptCore.lib, WTF.lib, bmalloc.lib and static ICU
# (sicuuc/sicuin/sicudt). These are *static* libs (there is no JavaScriptCore.dll),
# so the CLI links JSC in statically — nothing to ship next to lava.exe.
#
# Usage: WEBKIT_TAG=<tag> DEST=<dir> scripts/fetch-webkit-windows.sh
# Leaves the extracted tree at $DEST/bun-webkit (lib/, include/, bin/).
set -euo pipefail

WEBKIT_TAG="${WEBKIT_TAG:?set WEBKIT_TAG to an oven-sh/WebKit release tag}"
DEST="${DEST:-webkit}"
ASSET="bun-webkit-windows-amd64.tar.gz"
URL="https://github.com/oven-sh/WebKit/releases/download/${WEBKIT_TAG}/${ASSET}"

if [ -d "${DEST}/bun-webkit/lib" ]; then
	echo "WebKit already present at ${DEST}/bun-webkit — skipping download"
	exit 0
fi

echo "Downloading ${URL}"
mkdir -p "${DEST}"
curl -fSL "${URL}" -o "${DEST}/${ASSET}"
echo "Extracting ${ASSET}"
tar -xzf "${DEST}/${ASSET}" -C "${DEST}"
rm -f "${DEST}/${ASSET}"
echo "JavaScriptCore ready at ${DEST}/bun-webkit"
