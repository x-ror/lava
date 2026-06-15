#!/usr/bin/env bash
# Local port of the CI "Windows link + JSC smoke" step (.github/workflows/ci.yml).
# Links bin build/lava.exe against the provisioned bun-webkit JSC + OpenSSL using
# Odin's bundled lld, then runs the JSC smoke. Mirrors the CI logic exactly; the
# only local difference is sourcing the MSVC env from a vcvarsall dump rather than
# the ilammy/msvc-dev-cmd action.
set -euo pipefail
cd "$(dirname "$0")/.."

# --- MSVC env (LIB) from the vcvarsall x64 dump captured into build/vcvars-env.txt ---
ENVF=build/vcvars-env.txt
[ -f "$ENVF" ] || { echo "missing $ENVF (run vcvarsall x64 dump first)"; exit 1; }
MSVC_LIB="$(grep -i '^LIB=' "$ENVF" | head -1 | cut -d= -f2-)"
[ -n "$MSVC_LIB" ] || { echo "no LIB in $ENVF"; exit 1; }

mkdir -p build

# JSC static libs (bun-webkit), Windows path, prepended to LIB.
WK_WIN="$(cygpath -w "$PWD/webkit/bun-webkit/lib")"
export LIB="$WK_WIN;$MSVC_LIB"

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

echo "=== JSC smoke ==="
echo 'console.log("jsc-smoke:" + (40 + 2))' > smoke.js
set +e
./build/lava.exe run smoke.js > smoke.out 2>&1
code=$?
set -e
echo "lava.exe exit code: $code"
echo "--- output ---"; cat smoke.out
grep -q "jsc-smoke:42" smoke.out || { echo "JSC SMOKE FAIL: bad output"; exit 1; }
[ "$code" = "0" ] || { echo "JSC SMOKE FAIL: expected exit 0, got $code"; exit 1; }
echo "JSC SMOKE PASS"
