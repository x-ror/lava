// Self-test for the global-replace detector.
//
// Every fixture below is a shape that a real pass over this tree either caught or MISSED
// while the ROADMAP claimed zero. The three marked `regression:` are the ones that
// shipped a false "closed tree-wide" claim, so they are the reason this file exists: a
// detector that stops seeing them must fail before it is allowed to report on the tree.
import { scanSource } from './global-replace-detect.mjs';

const FIXTURES = [
  // --- must COUNT ---
  { name: 'inline global literal', expect: 1, src: `s.replace(/x/g, 'y');` },
  { name: 'inline global literal, replaceAll', expect: 1, src: `s.replaceAll(/x/g, 'y');` },
  { name: 'inline global literal, matchAll', expect: 1, src: `s.matchAll(/x/g);` },
  {
    name: 'regression: identifier bound to a global literal (missed by pass 1)',
    expect: 1,
    src: `var RE = /[\\\\"]/g;\nfunction f(s) { return s.replace(RE, '\\\\$&'); }`,
  },
  {
    name: 'regression: new RegExp(p, "g") binding (missed by passes 1 and 2)',
    expect: 1,
    src: `var RE = new RegExp('a' + 'b', 'g');\nfunction f(s) { return s.replace(RE, ''); }`,
  },
  {
    name: 'regression: binding used far from its declaration',
    expect: 1,
    src: `var RE = /\\u2E/g;\nfunction a() {}\nfunction b() {}\nfunction c(d) { return d.replace(RE, '.'); }`,
  },
  {
    name: 'primordial wrapper takes the pattern as arg 1',
    expect: 1,
    src: `StringPrototypeReplace(s, /x/g, 'y');`,
  },
  {
    name: 'computed flags are reported rather than assumed safe',
    expect: 1,
    src: `var RE = new RegExp('x', flags);\nfunction f(s) { return s.replace(RE, ''); }`,
  },
  {
    name: 'two sites in one file are both counted',
    expect: 2,
    src: `s.replace(/a/g, '');\nt.split(/b/g);`,
  },

  // --- must NOT count ---
  { name: 'non-global literal cannot spin', expect: 0, src: `s.replace(/x/, 'y');` },
  { name: 'string needle is not a regex', expect: 0, src: `s.replace('x', 'y');` },
  {
    name: 'non-global binding',
    expect: 0,
    src: `var RE = /x/;\nfunction f(s) { return s.replace(RE, ''); }`,
  },
  {
    name: 'new RegExp without the g flag',
    expect: 0,
    src: `var RE = new RegExp('x', 'i');\nfunction f(s) { return s.replace(RE, ''); }`,
  },
  {
    name: 'new RegExp with no flags argument',
    expect: 0,
    src: `var RE = new RegExp('x');\nfunction f(s) { return s.replace(RE, ''); }`,
  },
  {
    name: 'global regex not reaching a looping method',
    expect: 0,
    src: `var RE = /x/g;\nRE.exec(s);`,
  },
  { name: 'unrelated identifier argument', expect: 0, src: `s.replace(notARegex, 'y');` },
  { name: 'a method that is not in the looping set', expect: 0, src: `s.padStart(/x/g);` },
];

export function selfTest() {
  const failures = [];
  for (const f of FIXTURES) {
    let got;
    try {
      got = scanSource(f.src, f.name).length;
    } catch (err) {
      failures.push(`${f.name}: threw ${err.message}`);
      continue;
    }
    if (got !== f.expect) failures.push(`${f.name}: expected ${f.expect} hit(s), got ${got}`);
  }
  return failures;
}

export { FIXTURES };
