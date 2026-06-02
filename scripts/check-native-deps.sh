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

if [ "$missing" -ne 0 ]; then
	printf '%s\n' 'Install the missing development package before enabling native JSC runtime execution.'
	exit 1
fi
