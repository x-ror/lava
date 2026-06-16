#!/usr/bin/env bash
# Compile the Windows JavaScriptCore initialization shim (pkg/jsc/jsc_init_windows.cpp)
# into a static build/jsc_init.lib. The shim calls JSC's one-time process bring-up
# (WTF main thread + JSC::initialize) which a statically-linked JSC never gets on
# its own; without it the JIT/GC threads corrupt memory mid-execution on Windows
# (0xC0000409). See the .cpp header comment for the full rationale.
#
# The shim forward-declares the two entry points (no WebKit headers — the release
# payload's internal headers are incomplete), so this is a plain self-contained C++
# TU; the mangled references resolve against WTF.lib / JavaScriptCore.lib at link.
#
# Assumes the MSVC build environment is active (cl/lib on PATH, INCLUDE/LIB
# populated): the CI Windows job gets it from ilammy/msvc-dev-cmd; the local
# scripts/link-windows-local.sh sources it from a vcvarsall dump before calling us.
set -euo pipefail
cd "$(dirname "$0")/.."

# Don't let MSYS rewrite cl's /flag arguments into paths.
export MSYS2_ARG_CONV_EXCL='*'

mkdir -p build
SRC="pkg/jsc/jsc_init_windows.cpp"

if ! command -v cl >/dev/null 2>&1 || ! command -v lib >/dev/null 2>&1; then
	cat <<'EOF'
missing MSVC compiler tools: cl.exe and/or lib.exe are not on PATH

Run this from a Visual Studio x64 developer environment (the CI gets it from
ilammy/msvc-dev-cmd; locally scripts/link-windows-local.sh sources a vcvarsall dump).
EOF
	exit 1
fi

if [ -f build/jsc_init.lib ] && [ build/jsc_init.lib -nt "$SRC" ]; then
	echo "build/jsc_init.lib up to date — skipping compile"
	exit 0
fi

# /MT (static release CRT) matches the bun-webkit libs (DEFAULTLIB:libcmt/libcpmt)
# and the sqlite shim, so the C++ runtime folds into the exe's single static CRT.
# /std:c++20 for std::call_once usage parity with the engine; /EHsc for the lambda.
SRC_WIN="$(cygpath -w "$PWD/$SRC")"
OBJ_WIN="$(cygpath -w "$PWD/build/jsc_init.obj")"
echo "Compiling $SRC -> build/jsc_init.lib"
cl /nologo /c /O2 /MT /EHsc /std:c++20 "$SRC_WIN" /Fo"$OBJ_WIN"
lib /nologo /OUT:build/jsc_init.lib build/jsc_init.obj
echo "build/jsc_init.lib ready"
