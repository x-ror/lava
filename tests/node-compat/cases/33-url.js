// WHATWG URL and URLSearchParams parity (issue: URL/URLSearchParams support).
// Exercises parsing, serialization, relative resolution, every documented getter,
// the setter surface, query mutations (duplicates/empty values/percent encoding/
// Unicode), and both the global and module entry points. Every assertion holds on
// Node, and the runner diffs Lava's output against Node's, so any divergence fails.
'use strict';
const assert = require('node:assert/strict');

// --- module exports: require('node:url') and require('url') resolve to the same
//     object and expose URL/URLSearchParams + the helper functions ---
const nodeUrl = require('node:url');
const bareUrl = require('url');
assert.equal(nodeUrl, bareUrl, "require('node:url') === require('url')");
assert.equal(typeof nodeUrl.URL, 'function');
assert.equal(typeof nodeUrl.URLSearchParams, 'function');
assert.equal(typeof nodeUrl.fileURLToPath, 'function');
assert.equal(typeof nodeUrl.pathToFileURL, 'function');
assert.equal(typeof nodeUrl.urlToHttpOptions, 'function');
assert.equal(typeof nodeUrl.format, 'function');
assert.equal(typeof nodeUrl.domainToASCII, 'function');
assert.equal(typeof nodeUrl.domainToUnicode, 'function');

// --- global API availability ---
assert.equal(typeof globalThis.URL, 'function');
assert.equal(typeof globalThis.URLSearchParams, 'function');
// The module export is the same constructor as the global.
assert.equal(nodeUrl.URL, globalThis.URL);
assert.equal(nodeUrl.URLSearchParams, globalThis.URLSearchParams);
// node:buffer's object-URL statics survive on the global URL.
assert.equal(typeof URL.createObjectURL, 'function');
assert.equal(typeof URL.revokeObjectURL, 'function');
// Brand / tags.
assert.equal(Object.prototype.toString.call(new URL('http://a.b/')), '[object URL]');
assert.equal(Object.prototype.toString.call(new URLSearchParams()), '[object URLSearchParams]');

// --- basic parsing + every getter ---
{
  const u = new URL('https://user:pass@example.com:8443/a/b?x=1&y=2#frag');
  assert.equal(u.href, 'https://user:pass@example.com:8443/a/b?x=1&y=2#frag');
  assert.equal(u.protocol, 'https:');
  assert.equal(u.username, 'user');
  assert.equal(u.password, 'pass');
  assert.equal(u.host, 'example.com:8443');
  assert.equal(u.hostname, 'example.com');
  assert.equal(u.port, '8443');
  assert.equal(u.pathname, '/a/b');
  assert.equal(u.search, '?x=1&y=2');
  assert.equal(u.hash, '#frag');
  assert.equal(u.origin, 'https://example.com:8443');
  assert.equal(u.toString(), u.href);
  assert.equal(u.toJSON(), u.href);
  assert.equal(JSON.stringify({ u }), JSON.stringify({ u: u.href }));
}

// The verification example from the task.
assert.equal(new URL('https://a.b/c?x=1').pathname, '/c');

// Default ports are dropped; an explicit default port round-trips away.
assert.equal(new URL('https://a.com:443/').port, '');
assert.equal(new URL('http://a.com:80/').href, 'http://a.com/');
assert.equal(new URL('http://a.com/').pathname, '/');
assert.equal(new URL('http://a.com').href, 'http://a.com/');

// Case-folding of scheme and host; path/query/fragment case preserved.
{
  const u = new URL('HTTP://Example.COM/PaTh?Q=V#Frag');
  assert.equal(u.protocol, 'http:');
  assert.equal(u.hostname, 'example.com');
  assert.equal(u.pathname, '/PaTh');
  assert.equal(u.search, '?Q=V');
  assert.equal(u.hash, '#Frag');
}

// Non-special scheme: opaque path, null origin.
{
  const u = new URL('mailto:hello@example.com');
  assert.equal(u.protocol, 'mailto:');
  assert.equal(u.pathname, 'hello@example.com');
  assert.equal(u.host, '');
  assert.equal(u.origin, 'null');
}

// IPv4 / IPv6 / numeric host normalization.
assert.equal(new URL('http://0x7f.1/').hostname, '127.0.0.1');
assert.equal(new URL('http://192.168.000.1/').hostname, '192.168.0.1');
assert.equal(new URL('http://[2001:db8::0:1]/').hostname, '[2001:db8::1]');
assert.equal(new URL('http://[::1]/').host, '[::1]');

// --- percent encoding + Unicode ---
assert.equal(new URL('https://a.com/p q').pathname, '/p%20q');
assert.equal(new URL('https://a.com/ünïcödé').pathname, '/%C3%BCn%C3%AFc%C3%B6d%C3%A9');
assert.equal(new URL('https://a.com/?q=ä').search, '?q=%C3%A4');
// Unicode host → Punycode in href/host/hostname.
assert.equal(new URL('https://例え.テスト/').hostname, 'xn--r8jz45g.xn--zckzah');
assert.equal(new URL('https://xn--r8jz45g.xn--zckzah/').href, 'https://xn--r8jz45g.xn--zckzah/');

// --- path normalization (dot segments) ---
assert.equal(new URL('http://a.com/x/y/../z/./w').pathname, '/x/z/w');
assert.equal(new URL('http://a.com/a/b/c/../../').pathname, '/a/');
assert.equal(new URL('http://a.com/../../x').pathname, '/x');

// --- malformed / relative inputs ---
assert.throws(
  () => new URL('not a url'),
  (e) => e instanceof TypeError && e.code === 'ERR_INVALID_URL',
);
assert.throws(() => new URL('http://'), TypeError);
assert.equal(URL.canParse('http://a.com'), true);
assert.equal(URL.canParse('nope'), false);
assert.equal(URL.parse('nope'), null);
assert.equal(URL.parse('http://a.com').href, 'http://a.com/');

// --- relative URL resolution against a base ---
{
  const base = 'https://base.com/dir/page?old#h';
  assert.equal(new URL('//cdn.com/lib.js', base).href, 'https://cdn.com/lib.js');
  assert.equal(new URL('/abs', base).href, 'https://base.com/abs');
  assert.equal(new URL('sibling', base).href, 'https://base.com/dir/sibling');
  assert.equal(new URL('../up', base).href, 'https://base.com/up');
  assert.equal(new URL('?q2', base).href, 'https://base.com/dir/page?q2');
  assert.equal(new URL('#h2', base).href, 'https://base.com/dir/page?old#h2');
  assert.equal(new URL('', base).href, 'https://base.com/dir/page?old');
  // A base passed as a URL object is accepted.
  assert.equal(new URL('x', new URL(base)).href, 'https://base.com/dir/x');
}

// --- serialization round-trips ---
for (const input of [
  'https://a.com/p?x=1&y=2#z',
  'http://u:p@h.com:81/a/b/c?d=e#f',
  'ftp://ftp.example.com/pub/file.txt',
  'ws://socket.example.com/feed',
  'https://例え.テスト/パス?q=値',
]) {
  assert.equal(new URL(new URL(input).href).href, new URL(input).href);
}

// --- setters ---
{
  // The task's verification example.
  const u = new URL('https://a.b/c?x=1');
  u.searchParams.set('x', '2');
  assert.equal(u.href, 'https://a.b/c?x=2');
}
{
  const u = new URL('http://a.com/p?q#h');
  u.protocol = 'https';
  assert.equal(u.protocol, 'https:');
  u.hostname = 'b.com';
  assert.equal(u.host, 'b.com');
  u.port = '8080';
  assert.equal(u.host, 'b.com:8080');
  assert.equal(u.href, 'https://b.com:8080/p?q#h');
  u.port = '';
  assert.equal(u.port, '');
  u.pathname = '/new';
  assert.equal(u.pathname, '/new');
  u.username = 'bob';
  u.password = 'secret';
  assert.equal(u.href, 'https://bob:secret@b.com/new?q#h');
}
// search / hash setters with and without leading punctuation; empty clears them.
{
  const u = new URL('http://a.com/p?old#frag');
  u.search = '?new=1';
  assert.equal(u.search, '?new=1');
  u.search = 'bare=2';
  assert.equal(u.search, '?bare=2');
  u.search = '';
  assert.equal(u.search, '');
  assert.equal(u.href, 'http://a.com/p#frag');
  u.hash = '#h2';
  assert.equal(u.hash, '#h2');
  u.hash = 'h3';
  assert.equal(u.hash, '#h3');
  u.hash = '';
  assert.equal(u.hash, '');
  assert.equal(u.href, 'http://a.com/p');
}
// The href setter fully re-parses.
{
  const u = new URL('http://a.com/p?x=1#h');
  u.href = 'https://other.com/y?z=2';
  assert.equal(u.hostname, 'other.com');
  assert.equal(u.search, '?z=2');
  assert.equal(u.hash, '');
  // searchParams stays in sync after an href reset.
  assert.equal(u.searchParams.get('z'), '2');
  assert.equal(u.searchParams.get('x'), null);
}

// --- URL.searchParams live binding ---
{
  const u = new URL('https://a.b/c?x=1&y=2');
  u.searchParams.append('x', '3');
  assert.equal(u.search, '?x=1&y=2&x=3');
  assert.equal(u.href, 'https://a.b/c?x=1&y=2&x=3');
  u.searchParams.delete('x');
  assert.equal(u.search, '?y=2');
  u.searchParams.delete('y');
  // Emptying the params drops the '?' entirely.
  assert.equal(u.search, '');
  assert.equal(u.href, 'https://a.b/c');
  // Mutating url.search re-syncs the bound searchParams.
  u.search = '?a=1&a=2';
  assert.deepEqual(u.searchParams.getAll('a'), ['1', '2']);
}

// --- standalone URLSearchParams: every required operation ---
{
  const sp = new URLSearchParams('a=1&b=2&a=3');
  assert.equal(sp.get('a'), '1'); // first value
  assert.deepEqual(sp.getAll('a'), ['1', '3']); // duplicates preserved
  assert.equal(sp.get('missing'), null);
  assert.equal(sp.has('a'), true);
  assert.equal(sp.has('z'), false);
  assert.equal(sp.has('a', '3'), true); // value-specific has (Node 20+)
  assert.equal(sp.has('a', '9'), false);
  assert.equal(sp.size, 3);

  sp.append('c', '4');
  assert.equal(sp.toString(), 'a=1&b=2&a=3&c=4');

  sp.set('a', 'X'); // collapses duplicates to one, updates in place
  assert.equal(sp.toString(), 'a=X&b=2&c=4');

  sp.delete('b');
  assert.equal(sp.toString(), 'a=X&c=4');

  // value-specific delete (Node 20+).
  const sp2 = new URLSearchParams('k=1&k=2&k=3');
  sp2.delete('k', '2');
  assert.deepEqual(sp2.getAll('k'), ['1', '3']);
}

// Construction from array, object, Map, another URLSearchParams.
assert.equal(
  new URLSearchParams([
    ['a', '1'],
    ['b', '2'],
  ]).toString(),
  'a=1&b=2',
);
assert.equal(new URLSearchParams({ a: '1', b: '2' }).toString(), 'a=1&b=2');
assert.equal(new URLSearchParams(new Map([['x', '1']])).toString(), 'x=1');
assert.equal(new URLSearchParams(new URLSearchParams('p=q')).toString(), 'p=q');
assert.equal(new URLSearchParams('?lead=1').toString(), 'lead=1'); // leading '?' stripped

// Empty values and keys.
assert.equal(new URLSearchParams('a=&b').toString(), 'a=&b=');
assert.equal(new URLSearchParams('=v').get(''), 'v');
assert.equal(new URLSearchParams('a=1&&b=2').toString(), 'a=1&b=2');

// Percent + '+' decoding/encoding (application/x-www-form-urlencoded).
assert.equal(new URLSearchParams('a+b=c+d').get('a b'), 'c d');
assert.equal(new URLSearchParams('x=%C3%A9').get('x'), 'é');
{
  const sp = new URLSearchParams();
  sp.append('k', 'a b&c');
  assert.equal(sp.toString(), 'k=a+b%26c');
}

// sort is stable by key (code units).
{
  const sp = new URLSearchParams('z=1&a=2&m=3&a=4');
  sp.sort();
  assert.equal(sp.toString(), 'a=2&a=4&m=3&z=1');
}

// --- iteration: entries / keys / values / forEach / Symbol.iterator ---
{
  const sp = new URLSearchParams('a=1&b=2&c=3');
  assert.deepEqual(
    [...sp],
    [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ],
  );
  assert.deepEqual(
    [...sp.entries()],
    [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ],
  );
  assert.deepEqual([...sp.keys()], ['a', 'b', 'c']);
  assert.deepEqual([...sp.values()], ['1', '2', '3']);
  const seen = [];
  sp.forEach((value, key) => seen.push(`${key}=${value}`));
  assert.deepEqual(seen, ['a=1', 'b=2', 'c=3']);
}

// --- helpers: domainToASCII/Unicode, urlToHttpOptions, format ---
assert.equal(nodeUrl.domainToASCII('例え.テスト'), 'xn--r8jz45g.xn--zckzah');
assert.equal(nodeUrl.domainToUnicode('xn--r8jz45g.xn--zckzah'), '例え.テスト');
// domainToASCII handles IPs and IDN, and validates: invalid domains return ''.
assert.equal(nodeUrl.domainToASCII('café.com'), 'xn--caf-dma.com');
assert.equal(nodeUrl.domainToASCII('LOUD.com'), 'loud.com');
assert.equal(nodeUrl.domainToASCII('0x7f.1'), '127.0.0.1');
assert.equal(nodeUrl.domainToASCII('[::1]'), '[::1]');
assert.equal(nodeUrl.domainToUnicode('xn--caf-dma.com'), 'café.com');
for (const bad of ['exa mple.com', 'a b.com', 'http://x', 'a@b', '%C0%AF.com', '[bad']) {
  assert.equal(nodeUrl.domainToASCII(bad), '', 'domainToASCII rejects ' + JSON.stringify(bad));
  assert.equal(nodeUrl.domainToUnicode(bad), '', 'domainToUnicode rejects ' + JSON.stringify(bad));
}

{
  const opts = nodeUrl.urlToHttpOptions(new URL('http://u:p@a.com:81/x?y=1#z'));
  assert.equal(opts.protocol, 'http:');
  assert.equal(opts.hostname, 'a.com');
  assert.equal(opts.port, 81);
  assert.equal(opts.path, '/x?y=1');
  assert.equal(opts.auth, 'u:p');
}
// urlToHttpOptions copies the URL's own enumerable properties (request options a
// caller attached) ahead of the standard fields, matching Node.
{
  const u = new URL('http://h/p?q#f');
  u.timeout = 5;
  u.agent = 'x';
  const opts = nodeUrl.urlToHttpOptions(u);
  assert.equal(opts.timeout, 5);
  assert.equal(opts.agent, 'x');
  assert.deepEqual(Object.keys(opts), [
    'timeout',
    'agent',
    'protocol',
    'hostname',
    'hash',
    'search',
    'pathname',
    'path',
    'href',
  ]);
}
{
  const u = new URL('http://u:p@a.com/path?q=1#h');
  assert.equal(nodeUrl.format(u, { auth: false }), 'http://a.com/path?q=1#h');
  assert.equal(nodeUrl.format(u, { fragment: false }), 'http://u:p@a.com/path?q=1');
  assert.equal(nodeUrl.format(u, { search: false }), 'http://u:p@a.com/path#h');
}

// pathToFileURL → fileURLToPath round-trips an absolute path (platform-agnostic:
// uses path.resolve so it works on POSIX and Windows alike).
{
  const path = require('node:path');
  const abs = path.resolve('some', 'dir with space', 'file.txt');
  const fileUrl = nodeUrl.pathToFileURL(abs);
  assert.equal(fileUrl.protocol, 'file:');
  assert.equal(nodeUrl.fileURLToPath(fileUrl), abs);
  assert.equal(nodeUrl.fileURLToPath(fileUrl.href), abs);
}
// A non-file URL is rejected with Node's documented code.
assert.throws(
  () => nodeUrl.fileURLToPath('http://example.com/x'),
  (e) => e instanceof TypeError && e.code === 'ERR_INVALID_URL_SCHEME',
);

// --- argument-type validation parity (programmer errors must throw, not coerce) ---
for (const bad of [123, undefined, null, {}, { href: 'file:///tmp/a' }, ['file:///x']]) {
  assert.throws(
    () => nodeUrl.fileURLToPath(bad),
    (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE',
    'fileURLToPath must reject ' + Object.prototype.toString.call(bad),
  );
  assert.throws(
    () => nodeUrl.pathToFileURL(bad),
    (e) => e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE',
    'pathToFileURL must reject ' + Object.prototype.toString.call(bad),
  );
}
// A real URL instance is still accepted by fileURLToPath (the round-trip block
// above passes a URL instance; here we just confirm it does not throw on a
// platform-appropriate absolute path).
{
  const path = require('node:path');
  const fileUrl = nodeUrl.pathToFileURL(path.resolve('rt', 'x'));
  assert.equal(typeof nodeUrl.fileURLToPath(fileUrl), 'string');
}

// --- USVString conversion: lone surrogates become U+FFFD ---
{
  const REPLACEMENT = '\uFFFD';
  const sp = new URLSearchParams([['k\uD800', 'v\uDC00']]); // lone high in key, lone low in value
  assert.equal(sp.get('k' + REPLACEMENT), 'v' + REPLACEMENT);
  assert.equal(sp.toString(), 'k%EF%BF%BD=v%EF%BF%BD');
  // A valid surrogate pair is preserved unchanged.
  assert.equal(new URLSearchParams([['a', '😀']]).get('a'), '😀');
  // URL setters convert too: the lone surrogate becomes U+FFFD, then the URL
  // serializer percent-encodes it (UTF-8 of U+FFFD is EF BF BD).
  const u = new URL('http://h/');
  u.hash = 'x\uD834y'; // lone high surrogate
  assert.equal(u.hash, '#x%EF%BF%BDy');
}

// --- platform-specific file: URL handling ---
if (process.platform === 'win32') {
  // Drive-letter and UNC round-trips, plus encoded-separator rejection.
  assert.equal(nodeUrl.fileURLToPath('file:///C:/foo/bar'), 'C:\\foo\\bar');
  assert.equal(nodeUrl.fileURLToPath('file://server/share/x'), '\\\\server\\share\\x');
  assert.equal(nodeUrl.pathToFileURL('C:\\foo\\bar').protocol, 'file:');
  assert.equal(nodeUrl.fileURLToPath(nodeUrl.pathToFileURL('C:\\foo\\bar')), 'C:\\foo\\bar');
  assert.throws(
    () => nodeUrl.fileURLToPath('file:///C:/foo%2Fbar'),
    (e) => e.code === 'ERR_INVALID_FILE_URL_PATH',
  );
  assert.throws(
    () => nodeUrl.fileURLToPath('file:///C:/foo%5Cbar'),
    (e) => e.code === 'ERR_INVALID_FILE_URL_PATH',
  );
  assert.throws(
    () => nodeUrl.fileURLToPath('file:///foo/bar'),
    (e) => e.code === 'ERR_INVALID_FILE_URL_PATH', // drive-less path is not absolute
  );
} else {
  // POSIX: only an empty or "localhost" host is allowed; others are rejected.
  assert.equal(nodeUrl.fileURLToPath('file:///foo/bar'), '/foo/bar');
  assert.equal(nodeUrl.fileURLToPath('file://localhost/foo/bar'), '/foo/bar');
  assert.equal(nodeUrl.fileURLToPath('file:///a%20b/c'), '/a b/c');
  assert.throws(
    () => nodeUrl.fileURLToPath('file://evil.com/x'),
    (e) => e.code === 'ERR_INVALID_FILE_URL_HOST',
  );
  assert.throws(
    () => nodeUrl.fileURLToPath('file:///foo%2Fbar'),
    (e) => e.code === 'ERR_INVALID_FILE_URL_PATH',
  );
}

console.log('url ok');
