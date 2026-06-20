// path.matchesGlob — a minimatch-style glob matcher. node and lava must agree. Patterns/
// paths are lowercase so the result is independent of the platform's case sensitivity.
const assert = require('node:assert/strict');
const path = require('node:path');
const m = (p, g) => path.matchesGlob(p, g);

// single-segment wildcards: '*'/'?' do not cross '/' nor match a leading dot
assert.equal(m('foo.js', '*.js'), true);
assert.equal(m('foo/bar.js', '*.js'), false);
assert.equal(m('.hidden', '*'), false);
assert.equal(m('a.b.c', '*.c'), true);
assert.equal(m('a', '?'), true);
assert.equal(m('ab', '?'), false);
assert.equal(m('a', '?*'), true);

// globstar spans segments but stops at a dotfile; an explicit dot pattern matches it
assert.equal(m('foo/bar.js', '**/*.js'), true);
assert.equal(m('a/b/c', '**/c'), true);
assert.equal(m('a/b/c', '**'), true);
assert.equal(m('a/.git/x', '**'), false);
assert.equal(m('a/.git/x', '**/.git/**'), true);
assert.equal(m('a/b/c', 'a/**'), true);
assert.equal(m('a', 'a/**'), false); // trailing-slash significance
assert.equal(m('a/', 'a/**'), true);
assert.equal(m('a/b/c', 'a/*/c'), true);

// brace expansion + character classes
assert.equal(m('x.ts', '*.{js,ts}'), true);
assert.equal(m('x.md', '*.{js,ts}'), false);
assert.equal(m('a', '[abc]'), true);
assert.equal(m('d', '[abc]'), false);
assert.equal(m('d', '[!abc]'), true);

// runs of '/' collapse; explicit '.' matches a dotfile; empty path
assert.equal(m('a//b', '*/*'), true);
assert.equal(m('.hidden', '.*'), true);
assert.equal(m('', '**'), true);
assert.equal(m('', '*'), false);

// brace ranges expand like minimatch
assert.equal(m('file2.js', 'file{1..3}.js'), true);
assert.equal(m('b', '{a..c}'), true);
// POSIX character classes; an invalid range matches nothing (does not throw)
assert.equal(m('a', '[[:alpha:]]'), true);
assert.equal(m('5', '[[:digit:]]'), true);
assert.equal(m('x', '[z-a]'), false);
// an explicit dot character class matches a dotfile
assert.equal(m('.env', '[.]env'), true);
// '.'/'..' segments are resolved before matching
assert.equal(m('a/./b', 'a/b'), true);
assert.equal(m('b', 'a/../b'), true);
// '\' is a path separator in patterns (windowsPathsNoEscape), not an escape
assert.equal(path.posix.matchesGlob('a/b', 'a\\b'), true);
assert.equal(path.posix.matchesGlob('a*b', 'a\\*b'), false);
// the win32 variant also treats '\' in the path as a separator; posix does not
assert.equal(path.win32.matchesGlob('a\\b', 'a/b'), true);
assert.equal(path.posix.matchesGlob('a\\b', 'a/b'), false);
// a leading '/' is absolute; a trailing '/' in the pattern marks a directory
assert.equal(m('foo/bar', '/foo/*'), false);
assert.equal(m('/foo/bar', '/foo/*'), true);
assert.equal(m('a', 'a/'), false);
assert.equal(m('/a/b/c', '**'), true); // a leading '**' absorbs the absolute prefix

// extended-glob (extglob) operators
assert.equal(m('js', '@(js|ts)'), true); // exactly one
assert.equal(m('jsx', '@(js|ts)'), false);
assert.equal(m('abab', '+(ab)'), true); // one or more
assert.equal(m('b', '*(a)'), false); // zero or more
assert.equal(m('aaa', '*(a)'), true);
assert.equal(m('aa', '?(a)'), false); // zero or one
assert.equal(m('c', '!(a|b)'), true); // anything except
assert.equal(m('a', '!(a|b)'), false);
assert.equal(m('file.js', '*.@(js|ts)'), true);
assert.equal(m('file.md', '*.@(js|ts)'), false);
assert.equal(m('x.css', '!(*.js)'), true);
assert.equal(m('x.js', '!(*.js)'), false);
assert.equal(m('ab', '@(a@(b|c))'), true); // nesting
assert.equal(m('foo.test.js', '*.+(test|spec).js'), true);
// negation respects following text (the negated part is only what the extglob consumes)
assert.equal(m('axc', 'a!(b)c'), true);
assert.equal(m('abc', 'a!(b)c'), false);
assert.equal(m('file.js', '!(*.js).js'), true);
assert.equal(m('bb', '!(b)'), true); // whole-segment negation: bb is not b
// a literal '(' inside an extglob alternative; an invalid alternative is dropped, not fatal
assert.equal(m('a(b', '@(a(b)'), true);
assert.equal(m('a', '@([z-a]|a)'), true);
// a nullable leading extglob lets a following '.' match a dotfile; the empty path matches a
// zero-length extglob
assert.equal(m('.b', '?(a).b'), true);
assert.equal(m('.b', '*.b'), false);
assert.equal(m('', '?(a)'), true);
assert.equal(m('', '*(a)'), true);

// non-string arguments throw ERR_INVALID_ARG_TYPE
assert.throws(() => path.matchesGlob(1, '*'), { code: 'ERR_INVALID_ARG_TYPE' });
assert.throws(() => path.matchesGlob('a', 2), { code: 'ERR_INVALID_ARG_TYPE' });

// matchesGlob is exposed on both posix and win32 variants
assert.equal(typeof path.posix.matchesGlob, 'function');
assert.equal(typeof path.win32.matchesGlob, 'function');

console.log('ok');
