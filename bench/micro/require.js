'use strict';

// require() cache-hit throughput: a repeated require of a builtin resolves through the
// JS loader and the native module cache (module_cache_get) every call. This tracks the
// hot path that the O(1) cache work touches — not cold module evaluation (which happens
// once), but the per-call lookup cost user code pays whenever it re-requires a module.
const { bench } = require('../lib/harness');

// Warm the cache once so the benchmark measures steady-state lookups, not first load.
require('node:events');
require('node:util');

bench('require-builtin-events', () => require('node:events'), {
  iterations: 100000,
});
bench('require-builtin-util', () => require('node:util'), {
  iterations: 100000,
});
