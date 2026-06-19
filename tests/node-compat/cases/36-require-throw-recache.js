// A module that throws while loading must NOT stay cached (Node parity): a later
// require re-runs its body rather than returning stale partial exports or a cached
// error. This drives the native module_cache_remove path — the loader pre-registers
// the in-progress module, then drops it (freeing the owned cache key) when the body
// throws.
//
// It runs on every platform through run-oracles.sh, so it covers that key-free path
// on Windows against lava.exe — where the Linux/macOS-only tracking-allocator unit
// test (cmd/lava/module_cache_alloc_test.odin) does not reach. That unit test still
// owns leak / bad-free detection; this case verifies the path executes and the module
// re-runs correctly cross-platform.
const assert = require('node:assert/strict');

globalThis.__throwingModuleRuns = 0;

// First require: the body runs once (counter -> 1), then throws.
assert.throws(() => require('../fixtures/throwing/boom'), /boom-on-load/);
assert.equal(globalThis.__throwingModuleRuns, 1);

// Second require: because the failed module was removed from the cache, the body
// RE-RUNS (counter -> 2) and throws again — not a stale cache hit.
assert.throws(() => require('../fixtures/throwing/boom'), /boom-on-load/);
assert.equal(globalThis.__throwingModuleRuns, 2);

console.log('ok');
