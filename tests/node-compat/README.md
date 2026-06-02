# Node Compatibility Tests

These files are a Node 22+ behavior corpus for modern Node-style runtime
support. Today, the runner executes them with Node as the oracle. Once Lava can
evaluate JavaScript through JSC, run the same corpus through Lava with:

```sh
RUN_LAVA=1 make test-node
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
