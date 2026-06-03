#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUN_NODE_DIR="$ROOT_DIR/tests/vendor/bun/test/js/node"

if [ ! -d "$BUN_NODE_DIR" ]; then
	printf '%s\n' 'Bun node test corpus is not vendored.'
	exit 1
fi

printf 'Bun node corpus: %s\n' "${BUN_NODE_DIR#$ROOT_DIR/}"
printf 'Files: '
find "$BUN_NODE_DIR" -type f | wc -l | tr -d ' '
printf '\n'
printf 'Top-level areas:\n'
for dir in "$BUN_NODE_DIR"/*/; do
	[ -d "$dir" ] || continue
	dir=${dir%/}
	printf '  %s\n' "${dir##*/}"
done | sort
