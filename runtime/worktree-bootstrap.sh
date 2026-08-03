#!/usr/bin/env sh
# Agent system — worktree isolation — bootstrap an isolated worktree for one task.
#
# Usage:
#   ./runtime/worktree-bootstrap.sh <branch-name> [base-ref]
#
# Creates the worktree OUTSIDE the main tree (so it is not ?? in the parent),
# installs node_modules, and prints env exports for parallel-safe smokes.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BRANCH=${1:?usage: worktree-bootstrap.sh <branch> [base-ref]}
BASE=${2:-HEAD}
PARENT=$(dirname -- "$ROOT_DIR")
SAFE_BRANCH=$(printf '%s' "$BRANCH" | tr '/:' '--')

# `$$` — not decoration. Without it every bootstrap of the same task resolves to
# one path, the existence guard below fires on the second attempt, and the whole
# pipeline for that issue dies on retry. A dropped `$` here shipped exactly that.
WT_BASE="$PARENT/lava-wt-$SAFE_BRANCH-$$"
WT=$WT_BASE
n=0
while [ -e "$WT" ]; do
	# pids are reused; a long-lived queue can land on a leftover worktree.
	n=$((n + 1))
	if [ "$n" -gt 50 ]; then
		echo "no free worktree path near $WT_BASE (50 taken)" >&2
		exit 1
	fi
	WT="$WT_BASE-$n"
done

# A second run for the same issue must not die on "branch already exists": give
# it a fresh branch and report which one, so the PR head is whatever we created
# rather than whatever the caller assumed.
if git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
	BRANCH="$BRANCH-$$"
	m=0
	while git -C "$ROOT_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; do
		m=$((m + 1))
		if [ "$m" -gt 50 ]; then
			echo "no free branch name near $BRANCH (50 taken)" >&2
			exit 1
		fi
		BRANCH="$1-$$-$m"
	done
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
	echo "export LAVA_BRANCH=$BRANCH"
	echo "export LAVA_BIN=$WT/bin/lava"
	echo "export FETCH_TEST_PORT=$PORT_BASE"
	echo "export FETCH_SMOKE_NONCE=wt-$$-$PORT_BASE"
	echo "export MULTICORE_TEST_PORT=$((PORT_BASE + 10))"
	echo "export LAVA_BENCH_LOCK=${TMPDIR:-/tmp}/lava-bench.lock"
	echo "# use: make -C \"\$LAVA_WORKTREE\" build"
	echo "# never: make -f \"\$LAVA_WORKTREE/Makefile\""
	echo "# never: git stash (shared refs/stash)"
	echo "# bench: flock \"\$LAVA_BENCH_LOCK\" make -C \"\$LAVA_WORKTREE\" bench-gate"
} | tee "$WT/.agent-env"

echo "worktree ready: $WT" >&2
