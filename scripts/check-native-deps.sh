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

if pkg-config --exists javascriptcoregtk-4.1; then
	printf 'javascriptcoregtk-4.1 '
	pkg-config --modversion javascriptcoregtk-4.1
elif pkg-config --exists javascriptcoregtk-6.0; then
	printf 'javascriptcoregtk-6.0 '
	pkg-config --modversion javascriptcoregtk-6.0
else
	printf '%s\n' 'missing: javascriptcoregtk-4.1 or javascriptcoregtk-6.0'
	missing=1
fi

if [ "$missing" -ne 0 ]; then
	printf '%s\n' 'Install the missing development package before enabling native JSC runtime execution.'
	exit 1
fi
