// Other half of the circular pair. Required from cycle-a while cycle-a is still
// loading, so cycle-a's exports are partial here: only `name` is set (assigned
// before the require), while `bName`/`done` are assigned after this returns.
// We read a.name (already present) and snapshot a's keys with Object.keys —
// avoiding any get of a not-yet-defined property (which Node would warn about).
const a = require('./cycle-a');
exports.name = 'b';
exports.aName = a.name;
exports.aKeysDuringCycle = Object.keys(a).join(',');
