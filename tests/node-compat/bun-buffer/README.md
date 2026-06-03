# Adapted Bun Buffer Tests

This directory contains Lava-friendly ports of selected tests from the vendored
Bun Node buffer corpus at `tests/vendor/bun/test/js/node`.

The selector script reports every vendored Bun JS/TS test file whose filename
contains `buffer`; the `ported/` directory contains tests already converted to
plain CommonJS plus `node:assert/strict`, so they can run under both Node and
Lava.

The ported tests live in `bun-buffer/ported/`, which the active compatibility
runner discovers automatically via its `*/ported` glob. Run them through the
canonical targets:

```sh
make test-compat       # Node as oracle
make test-compat-lava  # compare Node vs Lava
```

Run the selector/inventory with:

```sh
make bun-buffer-report
```

Not every Bun buffer test should be ported verbatim. Some depend on Bun-only
APIs (`Bun.gc`, `Bun.concatArrayBuffers`, `bun:test`), detached ArrayBuffer
features not present in the current Lava runtime, or large Node internal
harness files. Those stay visible in the report until we either implement the
required runtime surface or write a focused clean-room equivalent.

