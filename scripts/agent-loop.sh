#!/usr/bin/env bash
# Drain the agent queue once. Written for cron, usable by hand.
#
#   ./scripts/agent-loop.sh [--max N] [--provider claude]
#
# Cron runs with a near-empty environment: no shell profile, and a PATH of
# roughly /usr/bin:/bin. On this machine `node` and `claude` live under $HOME, so
# a crontab line calling `node` directly fails with "command not found" and the
# only trace is a mail nobody reads. This script pins what it needs instead.
#
# It also takes a lock. A drain can run for hours while cron fires every 30
# minutes; without flock the ticks stack up and several pipelines race the same
# queue. Overlapping runs exit immediately rather than queueing.
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

# Interactive shells find these through the user's profile; cron does not.
export PATH="$HOME/.vite-plus/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"

# Optional: local credentials for a provider that reads them from the
# environment. The Claude CLI normally uses its own store under $HOME, which
# cron already provides, so this is a convenience rather than a requirement.
if [ -f "$ROOT_DIR/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$ROOT_DIR/.env"
	set +a
fi

MAX=${AGENT_LOOP_MAX:-1}
PROVIDER=${AGENT_PROVIDER:-claude}
while [ $# -gt 0 ]; do
	case "$1" in
	--max)
		MAX=$2
		shift 2
		;;
	--provider)
		PROVIDER=$2
		shift 2
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
done

for bin in node gh; do
	command -v "$bin" >/dev/null 2>&1 || {
		echo "$bin not on PATH — fix the export in $0" >&2
		exit 1
	}
done

mkdir -p "$ROOT_DIR/.agent-state"
LOG="$ROOT_DIR/.agent-state/agent-loop.log"

# -n: a tick that finds the previous one still running gives up. Waiting would
# just build a backlog of drains that all want the same issues.
exec 9>"$ROOT_DIR/.agent-state/agent-loop.lock"
if ! flock -n 9; then
	echo "$(date -Is) skipped: a drain is already running" >>"$LOG"
	exit 0
fi

echo "$(date -Is) start max=$MAX provider=$PROVIDER" >>"$LOG"
node workflows/triggers/schedule.mjs --max "$MAX" --provider "$PROVIDER" >>"$LOG" 2>&1
status=$?
echo "$(date -Is) done exit=$status" >>"$LOG"
exit "$status"
