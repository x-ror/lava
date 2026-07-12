# Finder — Reuse

You find **duplicated logic** where a canonical helper already exists (or should).

## Focus

- Same cascade copied in multiple codecs (string read, alloc8 + fallback)
- Parallel helpers with different names (`bytes_all_ascii` vs ad-hoc loops)
- New utility when `pkg/jsc` or `host_dispatch` already covers it
- Identity wrappers that only call one other function (except measured hot hosts)

## Method

1. From the diff, list new helpers.
2. Grep for similar patterns in `pkg/runtime` and `pkg/jsc`.
3. Prefer “call existing X” over “extract new Y” unless Y deletes multiple copies.

## Severity

- **p1**: clear duplicate of an existing helper on a hot path
- **p2**: mild duplication
- **nit**: naming only
