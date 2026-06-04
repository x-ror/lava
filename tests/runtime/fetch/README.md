# Fetch transport smoke test

Exercises the Odin-backed `fetch` network transport end to end against a real
HTTP origin, comparing Lava's output to Node's.

- `server.js` — a tiny Node origin server (Content-Length, chunked, and POST
  echo routes).
- `cases.js` — fetch cases run under both Node and Lava; their stdout must match.

Run it:

```sh
make test-fetch-smoke
```

This is **not** part of `make test` because it binds a local TCP port, which a
sandboxed CI environment may disallow. The node-compat oracle
(`tests/node-compat/cases/08-fetch.js`) covers the `Headers`/`Request`/`Response`
surface without a network.

Today the transport is `http://` only (no TLS) and resolves DNS synchronously;
the connect/write/read path is non-blocking on the event loop. See `ROADMAP.md`.
