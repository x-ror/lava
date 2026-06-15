#!/usr/bin/env bash
# Local port of the CI Windows link step (.github/workflows/ci.yml).
# Links build/lava.exe against the provisioned bun-webkit JSC + OpenSSL using
# Odin's bundled lld. Mirrors the CI logic exactly; the only local difference is
# sourcing the MSVC env from a vcvarsall dump rather than the ilammy/msvc-dev-cmd
# action.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- MSVC env from the vcvarsall x64 dump captured into build/vcvars-env.txt ---
# We need LIB + INCLUDE (Windows-format, fed verbatim to cl/linker) and the MSVC
# bin dirs on PATH (converted to bash form) so cl/lib are found for the sqlite
# compile. CI gets all of this from ilammy/msvc-dev-cmd instead.
ENVF=build/vcvars-env.txt
[ -f "$ENVF" ] || { echo "missing $ENVF (run vcvarsall x64 dump first)"; exit 1; }
# The dump (PowerShell Out-File) has CRLF endings; strip the trailing \r from each
# value or it corrupts cygpath/the linker's last path entry.
MSVC_LIB="$(grep -i '^LIB=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r')"
[ -n "$MSVC_LIB" ] || { echo "no LIB in $ENVF"; exit 1; }
export INCLUDE="$(grep -i '^INCLUDE=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r')"
# Append the dump's PATH (Windows ';'-separated → bash ':'-separated) so cl.exe and
# lib.exe resolve. Append (not prepend): the dump's PATH includes C:\Windows\System32,
# whose find.exe/link.exe would otherwise shadow the Unix find/head the rest of this
# script relies on. cl/lib are unique to the MSVC dirs, so they still resolve.
MSVC_PATH_WIN="$(grep -i '^PATH=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '\r')"
if [ -n "$MSVC_PATH_WIN" ]; then
	MSVC_PATH_SH="$(cygpath -up "$MSVC_PATH_WIN")"
	export PATH="$PATH:$MSVC_PATH_SH"
fi

# vcvarsall on this VS 18 layout omits the MSVC toolset include dir from INCLUDE
# (it populates LIB correctly), so cl can't find stdarg.h. Derive it from cl.exe's
# location (.../VC/Tools/MSVC/<ver>/bin/HostX64/x64/cl → .../<ver>/include) and
# prepend. CI's ilammy/msvc-dev-cmd sets a complete INCLUDE, so this is local-only.
CL_PATH="$(command -v cl || true)"
if [ -n "$CL_PATH" ]; then
	TOOLSET_INC_WIN="$(cygpath -w "$(cd "$(dirname "$CL_PATH")/../../.." && pwd)/include")"
	case ";$INCLUDE;" in
	*";$TOOLSET_INC_WIN;"*) : ;;
	*) export INCLUDE="$TOOLSET_INC_WIN;$INCLUDE" ;;
	esac
fi

mkdir -p build

# Compile cached SQLite amalgamation to build/sqlite3.lib (cl/lib now on PATH).
# Invoke with the *same* interpreter ($BASH = Git Bash): a bare `bash`/shebang here
# can resolve to WSL's bash on this machine, which sees neither the MSVC toolchain
# nor the exported Windows PATH. CI runs this script directly under its bash shell.
"$BASH" scripts/build-sqlite-windows.sh

# JSC static libs (bun-webkit) + build/ (sqlite3.lib), Windows paths, prepended to LIB.
WK_DIR="${WEBKIT_DIR:-.deps/webkit/bun-webkit}"
[ -d "$WK_DIR/lib" ] || { echo "missing $WK_DIR/lib (run WEBKIT_TAG=<tag> scripts/fetch-webkit-windows.sh)"; exit 1; }
WK_WIN="$(cygpath -w "$PWD/$WK_DIR/lib")"
BUILD_WIN="$(cygpath -w "$PWD/build")"
export LIB="$WK_WIN;$BUILD_WIN;$MSVC_LIB"

# OpenSSL import libs (libssl.lib/libcrypto.lib). MD = dynamic release CRT, matching
# Odin's default Windows CRT. Same find-the-dir approach as CI.
OSSL_LIB="$(find '/c/Program Files/OpenSSL-Win64' '/c/Program Files/OpenSSL' -ipath '*x64*MD*' -iname 'libssl.lib' 2>/dev/null | head -1 || true)"
[ -n "$OSSL_LIB" ] || OSSL_LIB="$(find '/c/Program Files/OpenSSL-Win64' '/c/Program Files/OpenSSL' -iname 'libssl.lib' 2>/dev/null | head -1 || true)"
if [ -n "$OSSL_LIB" ]; then
  export LIB="$(cygpath -w "$(dirname "$OSSL_LIB")");$LIB"
  echo "OpenSSL libs: $(dirname "$OSSL_LIB")"
else
  echo "WARNING: libssl.lib not found"
fi

# compiler-rt int128 builtins __divti3/__fixdfti (JSC references but doesn't bundle).
RT_LIB="$(find '/c/Program Files/LLVM' -iname 'clang_rt.builtins-x86_64.lib' 2>/dev/null | head -1 || true)"
RT_OBJS=""
if [ -n "$RT_LIB" ]; then
  AR="$(command -v llvm-ar || echo '/c/Program Files/LLVM/bin/llvm-ar.exe')"
  rm -rf build/rt && mkdir -p build/rt && ( cd build/rt && "$AR" x "$RT_LIB" )
  for sym in divti3 fixdfti; do
    f="$(find build/rt -name "${sym}.c.obj" | head -1)"
    [ -n "$f" ] && RT_OBJS="$RT_OBJS $(cygpath -w "$f")"
  done
  echo "extracted compiler-rt builtins:$RT_OBJS"
else
  echo "WARNING: clang_rt.builtins-x86_64.lib not found"
fi

SYSLIBS="Synchronization.lib user32.lib gdi32.lib ole32.lib oleaut32.lib shell32.lib shlwapi.lib advapi32.lib winmm.lib bcrypt.lib crypt32.lib ws2_32.lib userenv.lib dbghelp.lib iphlpapi.lib version.lib comctl32.lib rpcrt4.lib secur32.lib usp10.lib windowscodecs.lib"

echo "=== odin build (lld) ==="
odin build cmd/lava -collection:lava=. -out:build/lava.exe -linker:lld \
  -extra-linker-flags:"$RT_OBJS WTF.lib bmalloc.lib sicuuc.lib sicuin.lib sicudt.lib $SYSLIBS"
