#!/usr/bin/env sh
set -eu

mkdir -p bin

# On macOS the fetch TLS transport links Homebrew OpenSSL (libssl/libcrypto),
# which is keg-only — its lib dir is not on the default linker search path. Add
# it via the linker so `-lssl`/`-lcrypto` resolve. No-op on Linux (system libssl
# is already on the default path) and when Homebrew/OpenSSL is absent.
EXTRA=""
if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
	SSL_PREFIX=$(brew --prefix openssl@3 2>/dev/null || brew --prefix openssl 2>/dev/null || true)
	if [ -n "${SSL_PREFIX:-}" ] && [ -d "$SSL_PREFIX/lib" ]; then
		EXTRA="-extra-linker-flags:-L$SSL_PREFIX/lib"
	fi
fi

odin build cmd/lava -collection:lava=. -out:bin/lava ${EXTRA:+"$EXTRA"}
