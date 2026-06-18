#!/usr/bin/env sh
set -eu

mkdir -p bin

# No extra linker flags are needed: Linux links system libssl/libcrypto from the
# default path, and macOS needs no OpenSSL linker flags for fetch TLS (#143).
# (Windows builds via scripts/build-windows.ps1.)
odin build cmd/lava -collection:lava=. -out:bin/lava
