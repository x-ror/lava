// A require() made from a deferred callback (here a setTimeout inside a nested
// module) must resolve relative specifiers against the calling module's own
// directory, not the entry file's (issue #56). require is bound to each module's
// dir, so async and sync requires resolve identically. Pre-fix Lava resolved the
// deferred require against the entry dir and rejected with MODULE_NOT_FOUND.
const assert = require('node:assert/strict');

async function main() {
  const tag = await require('../fixtures/deferred/outer.js');
  assert.equal(tag, 'inner-loaded-async');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
