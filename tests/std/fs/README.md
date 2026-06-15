# node:fs std tests

Cross-platform oracle tests for the native `node:fs` surface, diffed against Node
(exit status, stdout, stderr) on **Linux, macOS, and Windows**.

These exist alongside `tests/node-compat/cases/02-fs-path.js`, which is
intentionally POSIX-path-shaped (it asserts `path.sep === '/'`, uses `/tmp`, and
exercises the POSIX `node:path` surface) and therefore only runs on Linux/macOS.
The cases here use `path.join` everywhere and an OS-appropriate temp directory, so
the same file runs identically on every platform — including Windows, where the
node-compat suite does not run.

Each case prints its observable results (error `code`/`syscall`, never absolute
paths), so the node-vs-lava comparison is itself the judge of per-platform parity:
the tests hard-code no platform-specific error codes.

Run:

```sh
make test-fs-node   # Node-only smoke
make test-fs-lava   # build lava and compare every case against Node
```

On Windows CI the same cases run against `build/lava.exe` via
`scripts/run-fs-oracle.sh` (see `.github/workflows/ci.yml`).
