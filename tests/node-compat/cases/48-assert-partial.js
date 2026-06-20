// assert.partialDeepStrictEqual — every part of `expected` must appear in `actual`. node
// and lava must agree on pass/fail.
const assert = require('node:assert/strict');

// passing partial matches: extra actual properties/elements are allowed
assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1 });
assert.partialDeepStrictEqual({ a: { x: 1, y: 2 } }, { a: { x: 1 } });
assert.partialDeepStrictEqual({ a: 1 }, {});
// arrays match as an ordered subsequence
assert.partialDeepStrictEqual([1, 2, 3], [1, 3]);
assert.partialDeepStrictEqual([1, 2, 1], [1, 1]);
assert.partialDeepStrictEqual([{ a: 1 }, { b: 2 }, { c: 3 }], [{ b: 2 }, { c: 3 }]);
// Sets match as an order-independent subset; Maps by present keys with partial values
assert.partialDeepStrictEqual(new Set([1, 2, 3]), new Set([3, 1]));
assert.partialDeepStrictEqual(
  new Set([
    { a: 1, x: 1 },
    { a: 1, y: 1 },
  ]),
  new Set([{ a: 1, y: 1 }]),
);
assert.partialDeepStrictEqual(
  new Map([
    ['a', 1],
    ['b', { k: 2, extra: 3 }],
  ]),
  new Map([['b', { k: 2 }]]),
);
// typed arrays/buffers behave like arrays; Dates/RegExps compare wholly
assert.partialDeepStrictEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 3]));
assert.partialDeepStrictEqual({ d: new Date(0), r: /x/g }, { d: new Date(0), r: /x/g });

// failing cases throw an AssertionError with operator 'partialDeepStrictEqual'
const failing = [
  [{ a: 1 }, { a: 1, b: 2 }], // missing key
  [{ a: 1 }, { a: '1' }], // type strict
  [
    [1, 2, 3],
    [3, 1],
  ], // wrong order (not a subsequence)
  [[1], [1, 2]], // expected longer than actual
  [new Map([['a', 1]]), new Map([['b', 1]])], // missing map key
  [new Set([1, 2]), new Set([1, 2, 3])], // expected set bigger
  [5, 6],
  [5, { a: 1 }], // primitive vs object
  [/x/g, /x/i], // regex flags differ
];
for (const [a, e] of failing) {
  assert.throws(() => assert.partialDeepStrictEqual(a, e), { operator: 'partialDeepStrictEqual' });
}

console.log('ok');
