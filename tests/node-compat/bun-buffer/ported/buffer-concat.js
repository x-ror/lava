const assert = require('node:assert/strict');

{
  const result = Buffer.concat([Buffer.from('hello'), Buffer.from(' '), Buffer.from('world')]);
  assert.equal(result.toString(), 'hello world');
}

{
  const parts = [Buffer.from('hello'), Buffer.from(' '), Buffer.from('world')];
  assert.equal(Buffer.concat(parts, 11).toString(), 'hello world');

  const padded = Buffer.concat(parts, 15);
  assert.equal(padded.length, 15);
  assert.equal(padded.toString('utf8', 0, 11), 'hello world');
  assert.equal(padded[14], 0);

  assert.equal(Buffer.concat(parts, 5).toString(), 'hello');
}

assert.equal(Buffer.concat([]).length, 0);

{
  const buf = Buffer.from('test');
  const result = Buffer.concat([buf]);
  assert.equal(result.toString(), 'test');
  assert.notEqual(result, buf);
}
