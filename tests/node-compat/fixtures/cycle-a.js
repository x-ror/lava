// Half of a circular require pair (issue #57). cycle-a starts loading, requires
// cycle-b mid-body, and cycle-b requires cycle-a back — getting a's *partial*
// exports (only `name` is set so far). a then finishes with b's full exports.
exports.name = 'a';
const b = require('./cycle-b');
exports.bName = b.name;
exports.done = true;
