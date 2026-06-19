// node:punycode, node:process, node:console — added builtins. node and lava must
// produce identical output. (noDeprecation suppresses Node's punycode DEP0040 warning
// so stderr stays clean and matches lava; it's a harmless no-op under lava.)
process.noDeprecation = true;
const assert = require('node:assert/strict');
const punycode = require('node:punycode');
const proc = require('node:process');
const con = require('node:console');

// --- punycode ---
assert.equal(punycode.toASCII('mañana.com'), 'xn--maana-pta.com');
assert.equal(punycode.toUnicode('xn--maana-pta.com'), 'mañana.com');
assert.equal(punycode.encode('mañana'), 'maana-pta');
assert.equal(punycode.decode('maana-pta'), 'mañana');
assert.deepEqual(punycode.ucs2.decode('😀'), [0x1f600]);
assert.equal(punycode.ucs2.encode([0x1f600]), '😀');

// --- process module is the global process ---
assert.equal(proc, process);
assert.equal(typeof proc.platform, 'string');
assert.equal(typeof proc.version, 'string');
assert.equal(typeof proc.nextTick, 'function');

// --- console module exposes the logging methods ---
assert.equal(typeof con.log, 'function');
assert.equal(typeof con.error, 'function');
assert.equal(typeof con.warn, 'function');

console.log('ok');
