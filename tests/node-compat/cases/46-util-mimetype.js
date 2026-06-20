// util.MIMEType / util.MIMEParams — a WHATWG MIME parser. node and lava must match.
const assert = require('node:assert/strict');
const { MIMEType, MIMEParams } = require('node:util');

// parsing lowercases type/subtype and parameter names; values keep their case
const m = new MIMEType('Text/HTML;charset=utf-8;Foo=Bar');
assert.equal(m.type, 'text');
assert.equal(m.subtype, 'html');
assert.equal(m.essence, 'text/html');
assert.equal(m.toString(), 'text/html;charset=utf-8;foo=Bar');
assert.equal(m.params.get('charset'), 'utf-8');
assert.equal(m.params.get('foo'), 'Bar');
assert.equal(m.params.get('Foo'), null); // names are lowercased on parse

// leading/trailing whitespace is trimmed; a quoted value drops its quotes when it is a token
assert.equal(new MIMEType('  text/plain  ').toString(), 'text/plain');
assert.equal(new MIMEType('text/html; charset="UTF-8"').toString(), 'text/html;charset=UTF-8');
// a value with special chars stays quoted; first duplicate wins; empty/no-value dropped
assert.equal(new MIMEType('text/html; x="a;b c"').toString(), 'text/html;x="a;b c"');
assert.equal(new MIMEType('text/x; a=1; a=2').params.get('a'), '1');
assert.equal(new MIMEType('text/x; a=').toString(), 'text/x');
assert.equal(new MIMEType('text/x; novalue; a=b').toString(), 'text/x;a=b');
// an empty *quoted* value is kept; only an empty *unquoted* value is dropped (WHATWG)
assert.equal(new MIMEType('text/x; empty=""').toString(), 'text/x;empty=""');
assert.equal(new MIMEType('text/x; empty=""').params.get('empty'), '');

// setters lowercase + revalidate
const s = new MIMEType('text/plain;a=b');
s.type = 'IMAGE';
s.subtype = 'PNG';
assert.equal(s.toString(), 'image/png;a=b');

// MIMEParams: get/has/set/delete, serialization quoting, iteration order
const p = new MIMEParams();
p.set('a', 'has space');
p.set('b', 'tok');
p.set('c', '');
assert.equal(p.toString(), 'a="has space";b=tok;c=""');
assert.equal(p.has('a'), true);
p.delete('a');
assert.equal(p.has('a'), false);
assert.equal(p.get('missing'), null);
assert.deepEqual([...new MIMEType('text/x; a=1; b=2').params].flat(), ['a', '1', 'b', '2']);
assert.deepEqual([...new MIMEType('text/x; a=1; b=2').params.keys()], ['a', 'b']);
// set() escapes quotes/backslashes when serializing
const e = new MIMEType('text/x');
e.params.set('k', 'q"and\\bs');
assert.equal(e.toString(), 'text/x;k="q\\"and\\\\bs"');
// set() does NOT lowercase the name (parse does)
const cs = new MIMEType('text/x');
cs.params.set('MixedCase', 'V');
assert.equal(cs.params.has('MixedCase'), true);
assert.equal(cs.params.has('mixedcase'), false);

// invalid syntax throws ERR_INVALID_MIME_SYNTAX
assert.throws(() => new MIMEType('garbage'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => new MIMEType('text/'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => new MIMEType('/plain'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => p.set('bad name', 'v'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.throws(() => p.set('a', 'bad\x01'), { code: 'ERR_INVALID_MIME_SYNTAX' });

// form-feed (U+000C) is NOT HTTP whitespace: it is not trimmed and invalidates the type
const FF = String.fromCharCode(0x0c);
assert.throws(() => new MIMEType(FF + 'text/plain'), { code: 'ERR_INVALID_MIME_SYNTAX' });
assert.equal(new MIMEType('\ttext/plain').toString(), 'text/plain'); // tab IS whitespace

// a parameter after a quoted value survives across whitespace/';' (Node resumes parsing)
assert.equal(new MIMEType('text/x; a="b" c=d').toString(), 'text/x;a=b;c=d');
assert.equal(new MIMEType('text/x; a="b"xyz;c=d').toString(), 'text/x;a=b;c=d');
// trailing whitespace inside a (here unterminated) quoted value is preserved
assert.equal(new MIMEType('text/x;a="b\t').params.get('a'), 'b\t');

// MIMEParams#set returns undefined (like URLSearchParams#set)
assert.equal(new MIMEType('text/x').params.set('a', 'b'), undefined);

// MIMEType#toString serializes from internal data, ignoring a params.toString override
const ov = new MIMEType('text/x;a=b');
ov.params.toString = () => 'HACKED';
assert.equal(ov.toString(), 'text/x;a=b');

// the constructors require `new`
assert.throws(() => MIMEType('text/plain'), TypeError);
assert.throws(() => MIMEParams(), TypeError);

console.log('ok');
