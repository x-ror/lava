# Lava

Lava is an experimental Bun-inspired JavaScript runtime and toolkit written in
Odin. The runtime target is JavaScriptCore (JSC).

## Status

This repository is initialized with a small Odin CLI and the first package
boundaries for the runtime, package manager, bundler, and JSC integration.
Compatibility targets modern Node.js 22+ behavior rather than legacy Node APIs.

## Requirements

- Odin
- JavaScriptCore development headers and libraries
- SQLite development headers and libraries (for `node:sqlite`)
- OpenSSL development headers and libraries (for `fetch` HTTPS/TLS)

On Linux, the JSC package is exposed through `pkg-config` as `javascriptcoregtk-6.0`,
SQLite as `sqlite3`, and OpenSSL as `openssl`
(e.g. `apt-get install libjavascriptcoregtk-6.0-dev libsqlite3-dev libssl-dev`).

On macOS, JSC is provided by the `JavaScriptCore` framework and SQLite by the
system `libsqlite3`; OpenSSL comes from Homebrew (`brew install openssl@3`) and
`scripts/build.sh` adds its keg-only lib path to the link line.

## Build

The starter CLI does not link JSC yet:

```sh
make build
```

Run it:

```sh
make eval SOURCE="console.log('hello from Lava')"
make run FILE=app.js
```

Useful project commands:

```sh
make help
make check
make check-jsc
make check-native
make test
make test-node
make test-sqlite-node
make test-sqlite-lava
```

## Layout

- `cmd/lava` - command line entry point
- `pkg/runtime` - JavaScript runtime orchestration
- `pkg/runtime/eventloop` - native event-loop abstraction using io_uring/epoll on Linux
- `pkg/jsc` - JavaScriptCore foreign declarations
- `pkg/std/sqlite` - first modern standard-library target
- `pkg/bundler` - future bundling/transpilation work
- `pkg/install` - future package install and lockfile work
- `scripts` - project helper scripts

## Roadmap

1. Link JSC and evaluate source through `JSEvaluateScript`.
2. Add module loading and a small CommonJS/ESM compatibility layer.
3. Implement `lava run <file>`.
4. Add package install, lockfile, and cache primitives.
5. Add bundling and TypeScript/JSX transform support.
