'use strict';
// Internal modules must be immune to user code mutating shared prototypes or
// replacing globals (see pkg/runtime/js/internal/primordials.js). EventEmitter is
// the migrated proof: we poison the Array/Object intrinsics it uses internally,
// drive it through every method that touches them, then restore the intrinsics
// before printing (console/util are not primordialized yet). Node's EventEmitter
// is likewise immune, so this case must produce identical output under both.

const EventEmitter = require('node:events');

const realPush = Array.prototype.push;
const realUnshift = Array.prototype.unshift;
const realSlice = Array.prototype.slice;
const realSplice = Array.prototype.splice;
const realMap = Array.prototype.map;
const realCreate = Object.create;

const boom = function () {
  throw new Error('intrinsic pollution leaked into a built-in');
};

Array.prototype.push = boom;
Array.prototype.unshift = boom;
Array.prototype.slice = boom;
Array.prototype.splice = boom;
Array.prototype.map = boom;
Object.create = boom;

let calls = 0;
const ee = new EventEmitter(); // init() -> Object.create(null)
const a = function () { calls = calls + 1; };
const b = function () { calls = calls + 1; };
const c = function () { calls = calls + 1; };
const d = function () { calls = calls + 1; };

ee.on('e', a); // stored as a bare function
ee.on('e', b); // function -> [a, b]
ee.on('e', c); // array exists -> push(c)
ee.prependListener('e', d); // unshift(d) -> [d, a, b, c]
ee.emit('e'); // slice(handler) + apply each -> +4
ee.removeListener('e', b); // splice -> [d, a, c]
const names = ee.eventNames(); // Reflect.ownKeys
const count = ee.listeners('e').length; // map over the listener array
ee.emit('e'); // -> +3

// Restore the intrinsics before printing (the output path uses them).
Array.prototype.push = realPush;
Array.prototype.unshift = realUnshift;
Array.prototype.slice = realSlice;
Array.prototype.splice = realSplice;
Array.prototype.map = realMap;
Object.create = realCreate;

console.log(calls, names.join(','), count);
