// ESM<->ESM import cycle (issue #95): a.mjs and b.mjs import each other. Before
// the fix this recursed to a stack overflow because the transformed ESM body
// never pre-registered its namespace in the loader cache. With the precache the
// cycle partner sees the partial namespace and lazy (function-deferred) access
// resolves once both modules finish — matching Node.
import assert from 'node:assert/strict';
import { a, getA, viaB } from '../fixtures/esm-cycle/a.mjs';

assert.equal(a, 1);
assert.equal(getA(), 1);
assert.equal(viaB(), 2); // reaches b's binding through the cycle

console.log('ok');
