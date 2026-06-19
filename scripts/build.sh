#!/usr/bin/env sh
set -eu

mkdir -p bin

# Optimized release build by default (-o:speed). Override for a fast debug/iteration
# build, e.g. `LAVA_OPT=none ./scripts/build.sh`. Levels: none|minimal|size|speed|aggressive.
OPT="${LAVA_OPT:-speed}"

# No extra linker flags are needed: Linux links system libssl/libcrypto from the
# default path, and macOS needs no OpenSSL linker flags for fetch TLS (#143).
# (Windows builds via scripts/build-windows.ps1.)
odin build cmd/lava -collection:lava=. -out:bin/lava -o:"$OPT"
