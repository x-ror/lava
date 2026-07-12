# Project agent rules (lava)

## Quality gates after structural changes

Prefer these commands (Linux) before claiming done:

```sh
make check
make bun-buffer-tests   # when buffer/jsc touched
make test-http-smoke    # when http touched
make bench-gate         # when intentionally changing perf floors
```

## Structural policy (buffer / jsc)

1. Do not leave `pkg/runtime/buffer.odin` permanently over ~1000 lines — extract (e.g. `buffer_utf8.odin`, keep `buffer_simd.odin`).
2. Dedicated `*_host` wrappers only for **measured** hot natives; cold natives use generic `host_native_create`.
3. JSC string/view/host ABI lives under `pkg/jsc/`; do not park UTF-16→UTF-8 bridge in `environment.odin`.
4. Private ABI probes: latch failure only on self-test/probe mismatch — not on a single runtime alloc failure (`g_ok`).
5. Prefer pure vertical refactors (move → verify) over mixed behavior+structure commits.

## Multi-angle review

Use `/multi-review` (skill `.grok/skills/multi-review`) for Fable-style parallel angles A–E + finders before merge of large runtime PRs.

Human focus: P0/P1 from the merge report only.
