// equals, compare (instance + static), and the search family.
const assert = require('node:assert/strict');

// equals / compare.
assert.equal(Buffer.from('abc').equals(Buffer.from('abc')), true);
assert.equal(Buffer.from('abc').equals(Buffer.from('abd')), false);
assert.equal(Buffer.from('abc').equals(new Uint8Array([97, 98, 99])), true);
assert.equal(Buffer.from('abc').equals(Buffer.from('ab')), false);
assert.equal(Buffer.from('abc').compare(Buffer.from('abd')), -1);
assert.equal(Buffer.from('abd').compare(Buffer.from('abc')), 1);
assert.equal(Buffer.from('abc').compare(Buffer.from('abc')), 0);

// Buffer.compare works as an Array.prototype.sort comparator.
assert.equal(Buffer.compare(Buffer.from('a'), Buffer.from('b')), -1);
const sorted = [Buffer.from('c'), Buffer.from('a'), Buffer.from('b')].sort(Buffer.compare);
assert.equal(sorted.map((b) => b.toString()).join(''), 'abc');

// compare with explicit ranges.
const a = Buffer.from([1, 2, 3, 4, 5]);
const b = Buffer.from([3, 4, 5, 6, 7]);
assert.equal(a.compare(b, 0, 3, 2), 0);

// indexOf / lastIndexOf / includes.
const hay = Buffer.from('hello world');
assert.equal(hay.indexOf('o'), 4);
assert.equal(hay.indexOf('o', 5), 7);
assert.equal(hay.lastIndexOf('o'), 7);
assert.equal(hay.indexOf('z'), -1);
assert.equal(hay.includes('world'), true);
assert.equal(hay.includes('xyz'), false);

assert.equal(Buffer.from('hello').indexOf(108), 2); // by byte value
assert.equal(Buffer.from('hello').indexOf(Buffer.from('ll')), 2);
assert.equal(Buffer.from('hello').indexOf('l', -3), 2); // negative offset wraps
assert.equal(Buffer.from('hello').lastIndexOf('l', 2), 2);
assert.equal(Buffer.from('hello').indexOf('6c6c', 0, 'hex'), 2); // needle decoded as hex
assert.equal(Buffer.from('hello').indexOf(''), 0); // empty needle
