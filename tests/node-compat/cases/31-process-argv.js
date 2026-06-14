// process.argv layout (issue #102): [execPath, scriptPath, ...userArgs]. The
// compat runner invokes both engines with no extra args, so argv.slice(2) is
// empty and argv[1] is this file's absolute path. (argv[0] differs by engine —
// node vs lava binary — so only its type/shape is asserted.)
const assert = require('node:assert/strict');
const path = require('node:path');

assert.equal(typeof process.argv[0], 'string');
assert.ok(process.argv[0].length > 0);

// argv[1] is the absolute path of this script, NOT a subcommand like "run".
assert.equal(typeof process.argv[1], 'string');
assert.ok(path.isAbsolute(process.argv[1]), 'argv[1] should be absolute');
assert.ok(process.argv[1].endsWith('31-process-argv.js'));

// The universal process.argv.slice(2) is the user args — empty here.
assert.deepEqual(process.argv.slice(2), []);

console.log('ok');
