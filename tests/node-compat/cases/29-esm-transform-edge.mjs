// ESM transform edge cases the line/regex scanner mistranslated (issue #96): a
// trailing comment on an import, `export default function` keeping its binding,
// multi-declarator exports, string-/template-/comment-aware scanning, and two
// statements on one line. Diffed against Node.
import assert from 'node:assert/strict'; // trailing comment must be tolerated
import deflt, { x, shout } from '../fixtures/esm96/dep.mjs'; // and here

// export default function keeps its name (callable as a hoisted binding).
export default function bar() {
  return baz();
}
function baz() {
  return 'baz';
}
assert.equal(bar(), 'baz');

// Multi-declarator export exports every name.
export const a = 1,
  b = 2,
  c = 3;
assert.equal(a + b + c, 6);

// A brace inside a string must not desync statement scanning.
export const braces = '{ [ ( still a string ) ] }';
assert.equal(braces, '{ [ ( still a string ) ] }');

// import/export lines inside a template literal or block comment are inert text.
const tpl = `
import nope from 'nope';
export const alsoNope = 1;
`;
assert.ok(tpl.indexOf("import nope from 'nope'") !== -1);
/* commented out:
export function shouldNotExist() {}
*/
assert.equal(typeof globalThis.shouldNotExist, 'undefined');

// Two statements on one line: both are handled.
export const first = 'A';
export const second = 'B';
assert.equal(first + second, 'AB');

// Imported bindings resolve.
assert.equal(x, 10);
assert.equal(shout('hi'), 'hi!');
assert.equal(deflt, 'theDefault');

console.log('ok');
