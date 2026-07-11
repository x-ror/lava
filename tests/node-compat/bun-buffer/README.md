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
make test-compat            # Node as oracle
make test-compat-lava       # compare Node vs Lava
make bun-buffer-tests       # focused: run/compare only the ported buffer cases
```

`make bun-buffer-tests` wraps `scripts/report-bun-buffer-tests.sh`, which runs
each ported case under Node and (when a Lava binary is available) compares exit
status, stdout, and stderr Node-vs-Lava — the fast loop for broadening Buffer
coverage. Run the vendored-corpus selector/inventory with:

```sh
make bun-buffer-report
```

Beyond the originally adapted Bun cases, the `ported/` directory now includes
focused clean-room cases that exercise the behaviors real Node packages lean on
— `Buffer.from` input shapes and shared-memory semantics, `alloc`/`allocUnsafe`
and `concat` validation, `byteLength`/`isEncoding`, `toString` clamping across
every encoding, `slice`/`copy`/`fill`, `equals`/`compare`/search, the numeric
`read*`/`write*` accessors with their bounds-error codes, and `util.inspect`
`<Buffer ..>` rendering. Each encodes Node's expected behavior (so the cases
pass under Node) and the runner confirms Lava matches.

Not every Bun buffer test should be ported verbatim. Some depend on Bun-only
APIs (`Bun.gc`, `Bun.concatArrayBuffers`, `bun:test`), detached ArrayBuffer
features not present in the current Lava runtime, or large Node internal
harness files. Those stay visible in the report until we either implement the
required runtime surface or write a focused clean-room equivalent.
