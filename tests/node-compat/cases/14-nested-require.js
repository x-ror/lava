// Relative require resolution from nested modules (PR #50).
// Each module's relative specifier must resolve against its OWN directory, and
// every specifier here is extensionless (../fixtures/nested/a, ./sub/b, ./c) so
// the chain also exercises the abs()->clean() fallback for candidate paths that
// do not exist until an extension is appended. On master this throws
// MODULE_NOT_FOUND (specifiers resolved against the entry dir, no ext fallback).
const assert = require('node:assert/strict');

const a = require('../fixtures/nested/a');

// entry -> a (1) -> sub/b (2) -> sub/c (3): each level adds its own value.
assert.equal(a.value, 1);
assert.equal(a.sum, 1 + (2 + 3));

// Each module saw __dirname as its own directory, not the entry's.
assert.equal(a.dir, 'nested');
assert.equal(a.bdir, 'sub');
