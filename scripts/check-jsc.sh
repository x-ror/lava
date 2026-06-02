#!/usr/bin/env sh
set -eu

if pkg-config --exists javascriptcoregtk-4.1; then
	pkg-config --cflags --libs javascriptcoregtk-4.1
	exit 0
fi

if pkg-config --exists javascriptcoregtk-6.0; then
	pkg-config --cflags --libs javascriptcoregtk-6.0
	exit 0
fi

printf '%s\n' "JavaScriptCore was not found through pkg-config."
printf '%s\n' "Install a JavaScriptCore development package, then rerun this script."
exit 1

