#!/usr/bin/env sh
set -eu

mkdir -p bin
odin build cmd/lava -out:bin/lava

