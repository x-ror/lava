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

# OpenSSL (fetch HTTPS/TLS): Linux exposes it via pkg-config; macOS uses keg-only
# Homebrew OpenSSL, which is usually not on the pkg-config path, so check brew.
if [ "$(uname -s)" = "Darwin" ]; then
	if command -v brew >/dev/null 2>&1 && brew --prefix openssl@3 >/dev/null 2>&1; then
		printf 'openssl@3 (brew) %s\n' "$(brew --prefix openssl@3)"
	else
		printf '%s\n' 'missing: openssl@3 (run: brew install openssl@3)'
		missing=1
	fi
else
	check_pkg openssl
fi

if [ "$missing" -ne 0 ]; then
	printf '%s\n' 'Install the missing development package before enabling native JSC runtime execution.'
	exit 1
fi
