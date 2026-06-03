#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUN_NODE_DIR="$ROOT_DIR/tests/vendor/bun/test/js/node"
PORTED_DIR="$ROOT_DIR/tests/node-compat/bun-buffer/ported"

if [ ! -d "$BUN_NODE_DIR" ]; then
	printf '%s\n' 'Bun node test corpus is not vendored.'
	exit 1
fi

printf '%s\n' 'Vendored Bun buffer-related files:'
find "$BUN_NODE_DIR" -type f \( -name '*buffer*.js' -o -name '*buffer*.ts' -o -name '*buffer*.mjs' -o -name '*buffer*.cjs' \) \
	| sed "s#^$ROOT_DIR/##" \
	| sort

printf '\n%s\n' 'Adapted Lava-friendly ports:'
find "$PORTED_DIR" -type f -name '*.js' \
	| sed "s#^$ROOT_DIR/##" \
	| sort

printf '\nVendored count: '
find "$BUN_NODE_DIR" -type f \( -name '*buffer*.js' -o -name '*buffer*.ts' -o -name '*buffer*.mjs' -o -name '*buffer*.cjs' \) | wc -l | tr -d ' '
printf '\nPorted count: '
find "$PORTED_DIR" -type f -name '*.js' | wc -l | tr -d ' '
printf '\n'

