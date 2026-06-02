#!/usr/bin/env sh
set -eu

OS=$(uname -s)

if [ "$OS" = "Darwin" ]; then
	framework="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/JavaScriptCore.framework"
	if [ -d "$framework" ]; then
		printf 'JavaScriptCore.framework (system, macOS)\n'
		exit 0
	fi
	printf '%s\n' "JavaScriptCore.framework not found. Install Xcode Command Line Tools:"
	printf '%s\n' "  xcode-select --install"
	exit 1
fi

if pkg-config --exists javascriptcoregtk-6.0; then
	pkg-config --cflags --libs javascriptcoregtk-6.0
	exit 0
fi

if pkg-config --exists javascriptcoregtk-4.1; then
	pkg-config --cflags --libs javascriptcoregtk-4.1
	exit 0
fi

printf '%s\n' "JavaScriptCore was not found through pkg-config."
printf '%s\n' "Install a JavaScriptCore development package, e.g.:"
printf '%s\n' "  apt install libjavascriptcoregtk-6.0-dev   # Debian/Ubuntu"
printf '%s\n' "  dnf install webkitgtk6.0-devel              # Fedora"
exit 1
