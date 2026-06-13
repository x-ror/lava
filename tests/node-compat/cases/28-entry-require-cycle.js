// The CommonJS entry module must be registered in the loader cache under its
// resolved path (issue #95), so a helper that require()s the entry back gets the
// same (partial) instance instead of re-executing the entry's top level. Also
// exercises module.exports being initialized to {} on the entry (so the marker
// assignment below works without first reassigning module.exports).
const assert = require('node:assert/strict');

globalThis.__entryTopRuns = (globalThis.__entryTopRuns || 0) + 1;
module.exports.marker = 'entry';

const helper = require('../fixtures/entry-cycle-helper.js');

// The entry's top level ran exactly once...
assert.equal(globalThis.__entryTopRuns, 1);
// ...and the helper observed the entry's partial exports through the cache.
assert.equal(helper.sawMarker, 'entry');

console.log('ok');
