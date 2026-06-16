// Buffer rendering through util.inspect / console.log and INSPECT_MAX_BYTES.
const assert = require('node:assert/strict');
const util = require('node:util');
const buffer = require('node:buffer');

// util.inspect uses the custom hook: "<Buffer ..>" rather than an index dump.
assert.equal(util.inspect(Buffer.from([1, 2, 3])), '<Buffer 01 02 03>');
assert.equal(util.inspect(Buffer.alloc(0)), '<Buffer >');
assert.equal(Buffer.from([0xde, 0xad]).inspect(), '<Buffer de ad>');

// Nested Buffers render the same way.
assert.equal(util.inspect([Buffer.from([0xff])]), '[ <Buffer ff> ]');
assert.equal(util.inspect({ b: Buffer.from([1, 2]) }), '{ b: <Buffer 01 02> }');

// INSPECT_MAX_BYTES caps the dump and appends "... N more byte(s)".
const original = buffer.INSPECT_MAX_BYTES;
try {
  buffer.INSPECT_MAX_BYTES = 2;
  assert.equal(util.inspect(Buffer.from([1, 2, 3])), '<Buffer 01 02 ... 1 more byte>');
  assert.equal(util.inspect(Buffer.from([1, 2, 3, 4])), '<Buffer 01 02 ... 2 more bytes>');
} finally {
  buffer.INSPECT_MAX_BYTES = original;
}

// A generic object's custom hook is honored too: a string is used verbatim, a
// non-string result is inspected in its place, and the hook receives an inspect
// function as its third argument.
const customSym = Symbol.for('nodejs.util.inspect.custom');
assert.equal(util.inspect({ [customSym]: () => 'CUSTOM' }), 'CUSTOM');
assert.equal(util.inspect({ [customSym]: () => 123 }), '123');
assert.equal(util.inspect({ [customSym]: () => ({ a: 1 }) }), '{ a: 1 }');
assert.equal(util.inspect({ [customSym]: (_d, _o, insp) => typeof insp }), 'function');

// console.log of a Buffer goes through the same renderer (stdout is compared).
console.log(Buffer.from('hi'));
console.log([Buffer.from([0]), Buffer.from([255])]);
