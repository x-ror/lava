#!/usr/bin/env sh
set -eu

# ODIN_DEFINES is set by the Makefile (e.g. -define:JSC_GTK6=true for the
# javascriptcoregtk-6.0 backend). Default to empty for a plain build.
mkdir -p bin
odin build cmd/lava -collection:lava=. -out:bin/lava ${ODIN_DEFINES:-}
