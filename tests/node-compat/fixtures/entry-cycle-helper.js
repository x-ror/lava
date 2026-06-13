// Required by cases/28-entry-require-cycle.js; requires the entry back by path to
// prove the entry is cached (top level runs once, partial exports visible).
const entry = require('../cases/28-entry-require-cycle.js');
module.exports = { sawMarker: entry.marker };
