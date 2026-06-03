# Node Compatibility Tests

These files are a Node 22+ behavior corpus for modern Node-style runtime
support. The runner executes them with Node as the oracle, and Lava already
evaluates the same corpus through JSC. Compare Node vs Lava with:

```sh
make test-compat-lava
```

The cases intentionally cover APIs users expect from a Bun/Node-like runtime:

- CommonJS `require`, `module.exports`, `__dirname`, and `__filename`
- ESM `import`, `export`, `import.meta.url`
- `fs`, `path`, and JSON loading
- `Buffer`
- `process.argv`, `process.env`, and `process.cwd`
- timers and microtasks
- `events`
- `crypto`
- `fetch`

Active compatibility tests live in two places:

- `cases/` contains Lava's core Node compatibility cases.
- `*/ported/` contains focused ports adapted from vendored upstream suites
  (for example Bun's buffer tests).

Run all active compatibility tests with:

```sh
make test-compat       # Node as oracle over cases/ + */ported
make test-compat-lava  # compare Node vs Lava, skipping known-lava-gaps.txt
```

`make test-compat-lava` skips documented entries in `known-lava-gaps.txt`.
Use `make test-compat-lava-strict` to run the same suite without skips.

Vendored upstream tests under `tests/vendor/` are source material only. They are
not executed directly by the active compatibility runner.

For API surface coverage, run:

```sh
make api-surface
```

That report compares the clean-room Lava `Buffer` and `crypto` exports against
the local Node binary. It is intentionally a report, not a CI gate: missing Node
APIs should become compatibility work items, then behavior cases in `cases/`
once implemented.
