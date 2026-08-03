# Adapted Bun Buffer Tests

This directory holds Lava-friendly Buffer cases under `ported/`: some were
adapted from Bun's Node buffer tests; many are clean-room cases for shapes real
Node packages lean on. They are plain CommonJS + `node:assert/strict` so both
Node and Lava can run them.

The active compatibility runner discovers `*/ported` automatically. Focused
loop:

```sh
make test-compat            # Node as oracle (cases/ + */ported)
make test-compat-lava       # compare Node vs Lava
make bun-buffer-tests       # only the ported buffer cases node-vs-Lava
```

`make bun-buffer-tests` wraps `scripts/report-bun-buffer-tests.sh` (exit status,
stdout, stderr). The old `tests/vendor/bun` corpus and `make vendor-bun-report` /
`make bun-buffer-report` targets were removed — the vendor tree was never
checked in (`tests/vendor/` is gitignored) and those targets always failed.
