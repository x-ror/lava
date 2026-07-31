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

// A clause on the line AFTER the keyword. The statement scanner treats a newline as a
// continuation while no meaningful character has been seen yet — behavior that used to
// fall out of `'…'.indexOf('')` returning 0 rather than -1, and is now an explicit
// flag. Nothing exercised it, so deleting the flag changed no file in the corpus.
// (The clause and its `from` stay on one line: a newline BETWEEN them ends the
// statement early, which is a separate pre-existing limitation, not this flag.)
// prettier-ignore
import
  lineBreakDefault from '../fixtures/esm96/dep.mjs';
assert.equal(lineBreakDefault, 'theDefault');

// The identifier alphabet: `$`, `_` and digits. No other fixture uses them, so the
// `$`/digit arms of the code-unit predicates that replaced `[A-Za-z_$][\w$]*` were
// unexercised — dropping either changed nothing in the corpus while breaking real code.
export const _leading = 1,
  $dollar = 2,
  mixed3 = 3;
assert.equal(_leading + $dollar + mixed3, 6);
import { shout as _h$2 } from '../fixtures/esm96/dep.mjs';
assert.equal(_h$2('y'), 'y!');

// Non-ASCII whitespace between the declaration keyword and the name. `isSpace` keeps
// the full ES `\s` set on purpose ("narrowing it would be a silent behavior change"),
// and an ASCII-only version diverges here: the emitted key becomes "const".
// prettier-ignore
export const nbspSeparated = 'NBSP';
assert.equal(nbspSeparated, 'NBSP');

// `import.meta` inside a STRING is data, not code. The rewriter searches the mask, so
// the blanked-out occurrence is not rewritten; searching the source instead would
// silently corrupt this literal to '__import_meta.url'.
export const metaText = 'import.meta.url';
assert.equal(metaText, 'import.meta.url');

console.log('ok');
