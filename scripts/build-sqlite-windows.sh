#!/usr/bin/env bash
# Compile the SQLite amalgamation from the ignored dependency cache into a static
# build/sqlite3.lib for the Windows build. There is no system libsqlite3 on
# Windows, so node:sqlite links this statically (no DLL to ship). The source is
# fetched into .deps/sqlite by scripts/fetch-sqlite-windows.sh instead of being
# committed to the repository.
#
# Assumes the MSVC build environment is active (cl/lib on PATH, INCLUDE/LIB
# populated): the CI Windows job gets it from ilammy/msvc-dev-cmd; the local
# scripts/link-windows-local.sh sources it from a vcvarsall dump before calling us.
set -euo pipefail
cd "$(dirname "$0")/.."

# Don't let MSYS rewrite cl's /flag arguments into paths.
export MSYS2_ARG_CONV_EXCL='*'

mkdir -p build
SQLITE_SRC_DIR="${SQLITE_SRC_DIR:-.deps/sqlite}"
SRC="${SQLITE_SRC_DIR}/sqlite3.c"
if [ ! -f "$SRC" ]; then
	"$BASH" scripts/fetch-sqlite-windows.sh
fi
[ -f "$SRC" ] || { echo "missing $SRC (run scripts/fetch-sqlite-windows.sh)"; exit 1; }

if ! command -v cl >/dev/null 2>&1 || ! command -v lib >/dev/null 2>&1; then
	cat <<'EOF'
missing MSVC compiler tools: cl.exe and/or lib.exe are not on PATH

Run this from a Visual Studio x64 developer environment, for example:

  cmd /c "\"%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat\" && bash scripts/build-sqlite-windows.sh"

If you use Build Tools instead of Community, replace "Community" with
"BuildTools". The CI gets this environment from ilammy/msvc-dev-cmd.
EOF
	exit 1
fi

if [ -f build/sqlite3.lib ] && [ build/sqlite3.lib -nt "$SRC" ]; then
	echo "build/sqlite3.lib up to date — skipping compile"
	exit 0
fi

# /MT (static CRT) matches Odin's default Windows link (libucrt.lib), so sqlite's
# CRT calls fold into the exe's single static CRT — without it the link emits
# LNK4217 "locally defined symbol imported" for malloc/free/etc. The feature
# defines track a reasonable node:sqlite parity surface (math/FTS5/RTREE/column
# metadata); the suite needs none of them, but they keep future cases honest.
echo "Compiling $SRC -> build/sqlite3.lib"
cl /nologo /c /O2 /MT \
	/DSQLITE_ENABLE_MATH_FUNCTIONS \
	/DSQLITE_ENABLE_FTS5 \
	/DSQLITE_ENABLE_RTREE \
	/DSQLITE_ENABLE_COLUMN_METADATA \
	/DSQLITE_THREADSAFE=1 \
	"$SRC" /Fobuild/sqlite3.obj
lib /nologo /OUT:build/sqlite3.lib build/sqlite3.obj
echo "build/sqlite3.lib ready"
