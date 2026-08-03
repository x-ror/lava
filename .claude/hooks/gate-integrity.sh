#!/usr/bin/env sh
# PreToolUse entry for Claude Code / Grok (Claude-compat hooks).
# Reads event JSON on stdin; denies gate-weakening commands (exit 2 + JSON).
set -eu
ROOT="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$ROOT" ]; then
  ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
fi
exec node "$ROOT/scripts/agent-cycle/gate-integrity.mjs" --hook
