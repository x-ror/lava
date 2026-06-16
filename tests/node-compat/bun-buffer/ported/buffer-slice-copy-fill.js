// slice/subarray sharing, copy, and fill behavior.
const assert = require('node:assert/strict');

// slice and subarray return Buffers that share the parent's memory.
{
  const b = Buffer.from([1, 2, 3, 4]);
  const s = b.slice(1, 3);
  assert.ok(Buffer.isBuffer(s));
  s[0] = 9;
  assert.equal(b[1], 9); // shared
}
{
  const b = Buffer.from([1, 2, 3, 4]);
  const s = b.subarray(1, 3);
  s[0] = 8;
  assert.equal(b[1], 8);
}
// Negative indices wrap relative to the end (TypedArray semantics).
assert.deepEqual(Buffer.from([1, 2, 3, 4]).slice(-2), Buffer.from([3, 4]));

// copy: full, partial region, return value, and overlapping self-copy.
{
  const a = Buffer.from('hello');
  const out = Buffer.alloc(5);
  assert.equal(a.copy(out), 5);
  assert.equal(out.toString(), 'hello');
}
{
  const a = Buffer.from('hello');
  const out = Buffer.alloc(3);
  assert.equal(a.copy(out), 3); // truncated to target capacity
  assert.equal(out.toString(), 'hel');
}
{
  const a = Buffer.from('hello');
  const out = Buffer.alloc(5, 0x2d);
  a.copy(out, 1, 2, 4);
  assert.equal(out.toString(), '-ll--');
}
{
  const a = Buffer.from('abcde');
  a.copy(a, 0, 1); // overlapping
  assert.equal(a.toString(), 'bcdee');
}

// fill: number, string (repeats/cycles), region, encoded value, buffer value.
assert.deepEqual(Buffer.alloc(5).fill(0x41), Buffer.from('AAAAA'));
assert.deepEqual(Buffer.alloc(6).fill('ab'), Buffer.from('ababab'));
assert.equal(Buffer.alloc(6, 0x2d).fill('x', 1, 4).toString(), '-xxx--');
assert.deepEqual(Buffer.alloc(4).fill('aa', 'hex'), Buffer.from([0xaa, 0xaa, 0xaa, 0xaa]));
assert.deepEqual(Buffer.alloc(5).fill(Buffer.from([1, 2])), Buffer.from([1, 2, 1, 2, 1]));
