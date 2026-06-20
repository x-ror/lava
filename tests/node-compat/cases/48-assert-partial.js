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

// edge cases matching Node's strict-deep semantics:
const sym = Symbol.for('k');
// primitives use Object.is (−0 ≠ 0, NaN = NaN)
assert.partialDeepStrictEqual({ x: NaN }, { x: NaN });
assert.throws(() => assert.partialDeepStrictEqual({ x: 0 }, { x: -0 }));
// Map keys match by partial deep equality (not identity); Errors by name+message+cause
assert.partialDeepStrictEqual(
  new Map([
    [
      { id: 1, e: 2 },
      { a: 1, b: 2 },
    ],
  ]),
  new Map([[{ id: 1 }, { a: 1 }]]),
);
assert.partialDeepStrictEqual(
  new Error('boom', { cause: { a: 1, b: 2 } }),
  new Error('boom', { cause: { a: 1 } }),
);
assert.throws(() => assert.partialDeepStrictEqual(new Error('a'), new Error('b')));
// typed arrays compare element bits (so ±0 differ); ArrayBuffers/DataViews by bytes
assert.throws(() => assert.partialDeepStrictEqual(Float32Array.of(-0), Float32Array.of(0)));
assert.partialDeepStrictEqual(Float32Array.of(NaN), Float32Array.of(NaN));
assert.throws(() =>
  assert.partialDeepStrictEqual(Uint8Array.of(1).buffer, Uint8Array.of(2).buffer),
);
// sparse holes are ignored; expected array's own non-index props are required
assert.partialDeepStrictEqual([0, 1], [, 1]);
const earr = [1];
earr.x = 2;
assert.throws(() => assert.partialDeepStrictEqual([1], earr));
assert.partialDeepStrictEqual(Object.assign([1], { x: 2 }), earr);
// enumerable symbols are honored; a non-enumerable actual prop does not satisfy an expected key
assert.partialDeepStrictEqual({ [sym]: 1, a: 2 }, { [sym]: 1 });
assert.throws(() => assert.partialDeepStrictEqual({}, { [sym]: 1 }));
const nonEnum = {};
Object.defineProperty(nonEnum, 'h', { value: 1, enumerable: false });
assert.throws(() => assert.partialDeepStrictEqual(nonEnum, { h: 1 }));

console.log('ok');
