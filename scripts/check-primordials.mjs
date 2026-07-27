// Prototype-pollution ratchet for the embedded runtime JS layer.
//
// Internal modules under pkg/runtime/js run BEFORE and ALONGSIDE user code that
// can mutate shared prototypes (Array.prototype.push = …) or replace globals.
// A call like `arr.push(x)` or `s.charCodeAt(i)` resolves the method through the
// live (pollutable) prototype at call time, so a poisoned prototype silently
// corrupts a built-in. The fix is `require('primordials')` — captured, pristine
// methods invoked as `ArrayPrototypePush(arr, x)` (see primordials.js).
//
// This tool does NOT parse types, so it cannot tell `array.push` from
// `simpleQueue.push`. Instead it is a RATCHET: it counts syntactic pollutable
// method calls per file (comment/string/regex-aware) and fails only when a file
// exceeds its recorded baseline. Hardening a module lowers its count; the tool
// then prints the tighter baseline to commit. A genuine false positive (a call
// on a class instance whose class defines that method) can be silenced inline
// with a `// primordials-ok` comment on the same line, or simply left inside the
// baseline. New pollutable calls in a not-yet-hardened file are allowed up to
// the baseline; a hardened file (baseline 0) rejects any new one.
//
// Usage:
//   node scripts/check-primordials.mjs            # check against baseline
//   node scripts/check-primordials.mjs --update   # rewrite the baseline file
//
// Exit 1 if any file exceeds its baseline (or the baseline is stale under
// --update-less counts, which prints the update hint).

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const JS_DIR = join(ROOT, 'pkg', 'runtime', 'js', 'internal');
const BASELINE = join(ROOT, 'tests', 'node-compat', 'pollution-baseline.json');

// Pollutable prototype methods: Array/String mutators + accessors that read
// through the prototype chain. Includes .at and .normalize — the carriers of the
// two worst known URL vectors (IPv4 normalization bypass, host substitution).
const POLLUTABLE = new Set([
  // Array.prototype
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'concat', 'join',
  'reverse', 'sort', 'map', 'filter', 'forEach', 'reduce', 'reduceRight',
  'indexOf', 'lastIndexOf', 'includes', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'some', 'every', 'flat', 'flatMap', 'fill', 'copyWithin',
  'entries', 'keys', 'values', 'at',
  // String.prototype
  'charCodeAt', 'codePointAt', 'charAt', 'replace', 'replaceAll', 'split',
  'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'startsWith',
  'endsWith', 'padStart', 'padEnd', 'repeat', 'normalize', 'localeCompare',
  'match', 'matchAll', 'search', 'substr', 'substring',
]);

// Strip comments, string/template literals, and regex literals to a same-length
// space-filled shadow so a `.push(` inside a comment or string is not counted
// and line/column stay stable. A small scanner (not a full JS parser) that
// tracks the handful of contexts that can contain a `.method(` false match.
function shadow(src) {
  const out = new Array(src.length);
  let i = 0;
  const n = src.length;
  // Regex vs division disambiguation: a `/` starts a regex when the last
  // non-space significant char is one that cannot end an expression.
  let prevSignificant = '';
  const keep = (c) => c;
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      out[i++] = ' ';
      out[i++] = ' ';
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) out[i++] = blank(src[i]);
      if (i < n) {
        out[i++] = ' ';
        out[i++] = ' ';
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out[i++] = ' ';
      while (i < n) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < n) out[i++] = blank(src[i]);
          continue;
        }
        if (src[i] === q) {
          out[i++] = ' ';
          break;
        }
        out[i++] = blank(src[i]);
      }
      prevSignificant = 'x'; // a string literal ends an expression
      continue;
    }
    // Regex literal: `/` where a regex can start.
    if (c === '/' && canStartRegex(prevSignificant)) {
      out[i++] = ' ';
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') {
          out[i++] = ' ';
          if (i < n) out[i++] = blank(src[i]);
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          out[i++] = ' ';
          break;
        } else if (d === '\n') {
          // Unterminated regex — bail, treat as division after all.
          break;
        }
        out[i++] = blank(src[i]);
      }
      // consume flags
      while (i < n && /[a-z]/i.test(src[i])) out[i++] = ' ';
      prevSignificant = 'x';
      continue;
    }
    out[i] = keep(c);
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join('');
}

function canStartRegex(prev) {
  // A regex can begin when the previous significant char is empty or one that
  // cannot terminate an expression (operators, punctuation, keywords' ends).
  if (prev === '') return true;
  return '(,=:[!&|?{};+-*%<>~^'.includes(prev);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

// Count pollutable `.method(` calls in a file's shadowed source, honoring an
// inline `// primordials-ok` on the same original line.
function countFile(file) {
  const src = readFileSync(file, 'utf8');
  const shadowed = shadow(src);
  const origLines = src.split('\n');
  const re = /\.([A-Za-z]+)\s*\(/g;
  let m;
  let count = 0;
  const hits = [];
  while ((m = re.exec(shadowed)) !== null) {
    if (!POLLUTABLE.has(m[1])) continue;
    // line number of this match
    const upto = shadowed.slice(0, m.index);
    const line = upto.split('\n').length;
    if (/\/\/\s*primordials-ok/.test(origLines[line - 1] || '')) continue;
    count++;
    hits.push({ line, method: m[1] });
  }
  return { count, hits };
}

const files = walk(JS_DIR).sort();
const counts = {};
const allHits = {};
for (const file of files) {
  const key = relative(JS_DIR, file).split(sep).join('/');
  const { count, hits } = countFile(file);
  counts[key] = count;
  allHits[key] = hits;
}

const update = process.argv.includes('--update');
if (update) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Wrote ${BASELINE} — ${total} pollutable sites across ${files.length} files.`);
  process.exit(0);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  console.error(`No baseline at ${BASELINE}. Run: node scripts/check-primordials.mjs --update`);
  process.exit(1);
}

let failed = false;
let improved = false;
for (const key of Object.keys(counts)) {
  const now = counts[key];
  const base = baseline[key] ?? 0;
  if (now > base) {
    failed = true;
    console.error(
      `\n${key}: ${now} pollutable calls, baseline ${base} (+${now - base}). New sites:`,
    );
    for (const h of allHits[key]) console.error(`  ${key}:${h.line}  .${h.method}(`);
  } else if (now < base) {
    improved = true;
    console.log(`${key}: ${now} < baseline ${base} — hardened by ${base - now}.`);
  }
}

if (failed) {
  console.error(
    '\nPollution ratchet FAILED: a module gained pollutable prototype calls. Route them\n' +
      "through primordials (require('primordials')), or add `// primordials-ok` if the\n" +
      'receiver is a class instance, not an Array/String.',
  );
  process.exit(1);
}
if (improved) {
  console.log('\nRatchet improved — commit the tighter baseline:');
  console.log('  node scripts/check-primordials.mjs --update');
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`OK: pollution ratchet holds (${total} sites at or below baseline).`);
