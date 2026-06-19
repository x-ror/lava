// util.parseArgs — CLI argument parsing. node and lava must produce identical output.
const assert = require('node:assert/strict');
const { parseArgs } = require('node:util');

// long boolean + --name=value
let r = parseArgs({
  args: ['--verbose', '--name=lava'],
  options: { verbose: { type: 'boolean' }, name: { type: 'string' } },
});
assert.deepEqual({ ...r.values }, { verbose: true, name: 'lava' });
assert.deepEqual(r.positionals, []);

// short options, grouped, with a following value
r = parseArgs({
  args: ['-vn', 'x'],
  options: {
    verbose: { type: 'boolean', short: 'v' },
    name: { type: 'string', short: 'n' },
  },
});
assert.deepEqual({ ...r.values }, { verbose: true, name: 'x' });

// multiple + default + positionals
r = parseArgs({
  args: ['--tag=a', '--tag=b', 'pos1', 'pos2'],
  options: {
    tag: { type: 'string', multiple: true },
    env: { type: 'string', default: 'dev' },
  },
  allowPositionals: true,
});
assert.deepEqual({ ...r.values }, { tag: ['a', 'b'], env: 'dev' });
assert.deepEqual(r.positionals, ['pos1', 'pos2']);

// -- terminator routes the rest to positionals
r = parseArgs({
  args: ['--flag', '--', '--notanoption'],
  options: { flag: { type: 'boolean' } },
  allowPositionals: true,
});
assert.deepEqual({ ...r.values }, { flag: true });
assert.deepEqual(r.positionals, ['--notanoption']);

// strict-mode errors carry Node's codes
assert.throws(() => parseArgs({ args: ['--nope'], options: {} }), {
  code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
});
assert.throws(() => parseArgs({ args: ['pos'], options: {} }), {
  code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
});
assert.throws(() => parseArgs({ args: ['--name'], options: { name: { type: 'string' } } }), {
  code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
});

// tokens output
r = parseArgs({
  args: ['--foo'],
  options: { foo: { type: 'boolean' } },
  tokens: true,
});
assert.equal(Array.isArray(r.tokens), true);
assert.equal(r.tokens[0].kind, 'option');
assert.equal(r.tokens[0].name, 'foo');

// a string short option later in a group keeps its value (-abVALUE -> a:true, b:'VALUE')
r = parseArgs({
  args: ['-abVALUE'],
  options: { a: { type: 'boolean', short: 'a' }, b: { type: 'string', short: 'b' } },
});
assert.deepEqual({ ...r.values }, { a: true, b: 'VALUE' });

// a value flag does not leak into the next lone short option (-n x -f)
r = parseArgs({
  args: ['-n', 'x', '-f'],
  options: {
    name: { type: 'string', short: 'n' },
    flag: { type: 'boolean', short: 'f' },
  },
});
assert.deepEqual({ ...r.values }, { name: 'x', flag: true });

// an unknown inline option keeps its value under strict:false
r = parseArgs({ args: ['--foo=bar'], strict: false, options: {} });
assert.deepEqual({ ...r.values }, { foo: 'bar' });

// a consumed option value advances the token index for following positionals
r = parseArgs({
  args: ['--name', 'x', 'pos'],
  options: { name: { type: 'string' } },
  allowPositionals: true,
  tokens: true,
});
const positional = r.tokens.find((t) => t.kind === 'positional');
assert.equal(positional.index, 2);

console.log('ok');
