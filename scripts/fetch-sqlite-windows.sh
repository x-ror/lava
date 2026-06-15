#!/usr/bin/env bash
# Download the official SQLite amalgamation used by the Windows static build.
# Linux and macOS link their system libsqlite3; Windows has no default system
# libsqlite3, so we keep the source in the ignored dependency cache instead of
# committing it.
set -euo pipefail
cd "$(dirname "$0")/.."

SQLITE_VERSION="${SQLITE_VERSION:-3530200}"
SQLITE_YEAR="${SQLITE_YEAR:-2026}"
DEST="${DEST:-.deps/sqlite}"
ARCHIVE="sqlite-amalgamation-${SQLITE_VERSION}.zip"
URL="https://sqlite.org/${SQLITE_YEAR}/${ARCHIVE}"

if [ -f "${DEST}/sqlite3.c" ] && [ -f "${DEST}/sqlite3.h" ]; then
	echo "SQLite amalgamation already present at ${DEST} — skipping download"
	exit 0
fi

echo "Downloading ${URL}"
mkdir -p "${DEST}"
TMP="${DEST}/_download"
rm -rf "${TMP}"
mkdir -p "${TMP}"
curl -fSL "${URL}" -o "${TMP}/${ARCHIVE}"

echo "Extracting ${ARCHIVE}"
if command -v unzip >/dev/null 2>&1; then
	unzip -q "${TMP}/${ARCHIVE}" -d "${TMP}"
elif tar -tf "${TMP}/${ARCHIVE}" >/dev/null 2>&1; then
	tar -xf "${TMP}/${ARCHIVE}" -C "${TMP}"
elif command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
	PS_ARCHIVE="$(cygpath -w "${TMP}/${ARCHIVE}")"
	PS_DEST="$(cygpath -w "${TMP}")"
	powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '${PS_ARCHIVE}' -DestinationPath '${PS_DEST}' -Force"
else
	echo "could not extract ${ARCHIVE}: install unzip or use a tar that supports zip archives"
	exit 1
fi
SRC_DIR="${TMP}/sqlite-amalgamation-${SQLITE_VERSION}"
[ -f "${SRC_DIR}/sqlite3.c" ] || { echo "missing sqlite3.c in ${ARCHIVE}"; exit 1; }
cp "${SRC_DIR}/sqlite3.c" "${DEST}/sqlite3.c"
cp "${SRC_DIR}/sqlite3.h" "${DEST}/sqlite3.h"
rm -rf "${TMP}"
echo "SQLite amalgamation ready at ${DEST}"
