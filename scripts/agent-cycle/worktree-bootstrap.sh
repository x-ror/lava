#!/usr/bin/env sh
# Agent-cycle F2 — bootstrap an isolated worktree for one task.
#
# Usage:
#   ./scripts/agent-cycle/worktree-bootstrap.sh <branch-name> [base-ref]
#
# Creates the worktree OUTSIDE the main tree (so it is not ?? in the parent),
# installs node_modules, and prints env exports for parallel-safe smokes.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BRANCH=${1:?usage: worktree-bootstrap.sh <branch> [base-ref]}
BASE=${2:-HEAD}
PARENT=$(dirname -- "$ROOT_DIR")
SAFE_BRANCH=$(printf '%s' "$BRANCH" | tr '/:' '--')
WT="$PARENT/lava-wt-$SAFE_BRANCH-$$"

if [ -e "$WT" ]; then
	echo "worktree path already exists: $WT" >&2
	exit 1
fi

git -C "$ROOT_DIR" worktree add -b "$BRANCH" "$WT" "$BASE"
(
	cd "$WT"
	if command -v bun >/dev/null 2>&1; then
		bun install --frozen-lockfile
	elif command -v npm >/dev/null 2>&1; then
		npm ci
	else
		echo "warn: no bun/npm — JS gates will fail with ERR_MODULE_NOT_FOUND" >&2
	fi
)

# Per-worktree ports (F2): derived from pid so two bootstraps do not collide.
PORT_BASE=$((41000 + ($$ % 10000)))
{
	echo "export LAVA_WORKTREE=$WT"
	echo "export LAVA_BIN=$WT/bin/lava"
	echo "export FETCH_TEST_PORT=$PORT_BASE"
	echo "export FETCH_SMOKE_NONCE=wt-$$-$PORT_BASE"
	echo "export MULTICORE_TEST_PORT=$((PORT_BASE + 10))"
	echo "export LAVA_BENCH_LOCK=${TMPDIR:-/tmp}/lava-bench.lock"
	echo "# use: make -C \"\$LAVA_WORKTREE\" build"
	echo "# never: make -f \"\$LAVA_WORKTREE/Makefile\""
	echo "# never: git stash (shared refs/stash)"
	echo "# bench: flock \"\$LAVA_BENCH_LOCK\" make -C \"\$LAVA_WORKTREE\" bench-gate"
} | tee "$WT/.agent-cycle-env"

echo "worktree ready: $WT" >&2
