#!/usr/bin/env sh
set -eu

# Summarize the vendored Bun node test corpus.
#   (no argument) : overview — total file count and top-level areas.
#   buffer        : list the buffer-related vendored files plus the adapted
#                   Lava-friendly ports under tests/node-compat/bun-buffer/ported.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUN_NODE_DIR="$ROOT_DIR/tests/vendor/bun/test/js/node"
MODE=${1:-overview}

if [ ! -d "$BUN_NODE_DIR" ]; then
	printf '%s\n' 'Bun node test corpus is not vendored.'
	exit 1
fi

case "$MODE" in
overview)
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
	;;
buffer)
	PORTED_DIR="$ROOT_DIR/tests/node-compat/bun-buffer/ported"
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
	;;
*)
	printf 'usage: %s [buffer]\n' "$0" >&2
	exit 2
	;;
esac
