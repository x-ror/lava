#!/usr/bin/env sh
set -eu

missing=0

check_pkg() {
	name=$1
	if pkg-config --exists "$name"; then
		printf '%s ' "$name"
		pkg-config --modversion "$name"
	else
		printf 'missing: %s\n' "$name"
		missing=1
	fi
}

check_pkg javascriptcoregtk-6.0
check_pkg sqlite3

# OpenSSL (fetch HTTPS/TLS): only Linux needs it (exposed via pkg-config). macOS has
# no OpenSSL dependency for fetch TLS (#143), so there is nothing to check there.
if [ "$(uname -s)" != "Darwin" ]; then
	check_pkg openssl
fi

if [ "$missing" -ne 0 ]; then
	printf '%s\n' 'Install the missing development package before enabling native JSC runtime execution.'
	exit 1
fi
