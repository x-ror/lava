// Prototype-pollution ratchet for the embedded runtime JS layer.
//
// Internal modules under pkg/runtime/js run BEFORE and ALONGSIDE user code that
// can mutate shared prototypes (Array.prototype.push = …) or replace globals.
// A call like `arr.push(x)` or `s.charCodeAt(i)` resolves the method through the
// live (pollutable) prototype at call time, so a poisoned prototype silently
// corrupts a built-in. The fix is `require('primordials')` — captured, pristine
// methods invoked as `ArrayPrototypePush(arr, x)` (see primordials.js).
//
// FOUR classes are counted, each baselined separately (see KINDS):
//
//   method    `arr.push(x)`      — a pollutable Array/String prototype method
//   invoke    `fn.call(t, a)`    — resolved through Function.prototype at call time
//   accessor  `view.buffer`      — read through a configurable prototype getter
//   global    `String(x)`        — a replaceable global read live, not captured
//
// The accessor class exists because of a real miss: encoding.js sat at baseline
// 0 while `units.buffer` resolved through `%TypedArray%.prototype.buffer`, so a
// poisoned getter substituted an attacker's backing store on every non-fastpath
// decode — reachable from url.js with attacker-sized input. The tool reported
// OK, and a reviewer found it instead. A blind control is worse than none, so
// the detector now self-tests on every run (below) before it will report.
//
// This tool does NOT parse types, so it cannot tell `array.push` from
// `simpleQueue.push`. Instead it is a RATCHET: it counts syntactic sites per
// file per class (comment/string/regex-aware) and fails only when a file exceeds
// its recorded baseline for that class. Hardening a module lowers a count; the
// tool then prints the tighter baseline to commit. A genuine false positive (a
// call on a class instance whose class defines that method) can be silenced
// inline with a `// primordials-ok` comment on the same line, or simply left
// inside the baseline. On a line carrying candidates from MORE THAN ONE class
// the bare marker suppresses nothing — name the class,
// `// primordials-ok: method` — because a marker added for a known-safe
// `queue.push(x)` must not also hide the live global read beside it.
// Per-class baselines are what make "0" mean something: a
// file may be at 0 globals because it captures them and still carry accessor
// reads, and mixing the two into one number would let a fixed site pay for a
// new one.
//
// NOT covered, and deliberately: an object literal indexed by a caller-supplied
// key needs `__proto__: null` (CLAUDE.md §5c). Deciding that a literal is used
// as a lookup table with a dynamic key takes dataflow, which a scanner does not
// have; a blanket "every literal needs __proto__: null" would fire on every
// options object. That class stays on the author.
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

// The detector classes, in report order. Each is counted and baselined
// SEPARATELY — see the note at the counting loop.
const KINDS = ['method', 'invoke', 'accessor', 'global'];

// Dynamic invocation: resolved through Function.prototype at call time.
const INVOKE = new Set(['call', 'apply']);

// Prototype ACCESSORS worth counting. Deliberately a short list of names that
// are (a) reachable through a configurable prototype getter and (b) rare enough
// as ordinary property names that the false-positive rate stays low. `length`
// is NOT here on purpose: every `arr.length` would fire and the ratchet would
// become unusable, which is its own failure mode.
const ACCESSOR = new Set(['buffer', 'byteOffset', 'byteLength', 'constructor', '__proto__']);

// Globals a script can replace outright. Captured at module-eval, these are
// safe; read live inside a function body, they are the (b) vector CLAUDE.md §5
// describes.
const GLOBALS = new Set([
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Symbol', 'Promise',
  'Reflect', 'JSON', 'Math', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Buffer', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array',
  'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'RegExp', 'Date', 'Proxy',
]);

// The capture line is the FIX, not a finding: `var StringG = String;` or
// `var BufferFrom = Buffer.from;`. The RHS must be a bare reference — no call
// parens — because `var b = Buffer.from(x);` is a USE of a live global that
// merely happens to start with `var`, and exempting it would blind the class to
// the most common shape it exists to catch. Applied to the SHADOWED line so a
// trailing comment does not defeat the end anchor.
const CAPTURE_RE = /^\s*(?:var|const|let)\s+[\w$]+\s*=\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*;?\s*$/;

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
        // A template hole EXECUTES, so its expression must survive shadowing —
        // blanking the whole literal hid `${arr.push(x)}` from every detector.
        // Recursive, because a hole can contain another template, a string or a
        // comment, and those still need their own treatment.
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          out[i++] = ' ';
          out[i++] = ' ';
          const start = i;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth === 0) break;
            i++;
          }
          const inner = shadow(src.slice(start, i));
          for (let k = 0; k < inner.length; k++) out[start + k] = inner[k];
          if (i < n) out[i++] = ' '; // the closing brace
          continue;
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

// Function-body nesting depth at every index of the shadowed source.
//
// A capture is the FIX only when it runs at module-eval, before user code: the
// loader evaluates the module body first. The identical line inside a function
// body runs at CALL time, after a script has had every chance to replace the
// global, so there it is a read like any other. Depth 1 is the module wrapper
// every internal module is enclosed in; anything deeper is a real function.
//
// A `{` is treated as opening a function body when the previous significant
// character is `)` or the line ends in `=>`. That also catches `if (x) {`,
// which is deliberate: a capture inside a conditional is not the unconditional
// module-eval capture the exemption is for, and over-counting is the safe
// direction for a security control.
function functionDepths(shadowed) {
  const depths = new Int32Array(shadowed.length);
  const stack = [];
  let depth = 0;
  let prev = '';
  for (let i = 0; i < shadowed.length; i++) {
    const c = shadowed[i];
    if (c === '{') {
      const isFn = prev === ')' || shadowed.slice(Math.max(0, i - 3), i).includes('=>');
      stack.push(isFn);
      if (isFn) depth++;
    } else if (c === '}') {
      if (stack.pop()) depth = Math.max(0, depth - 1);
    }
    depths[i] = depth;
    if (!/\s/.test(c)) prev = c;
  }
  return depths;
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

// Count pollutable sites in already-read source, honoring an inline
// `// primordials-ok` on the same original line. Split from countFile so the
// self-test below can drive it on fixtures without touching the filesystem.
function countSource(src) {
  const shadowed = shadow(src);
  const origLines = src.split('\n');
  // Suppression reads the ORIGINAL line (the marker lives in a comment, which
  // shadow() has blanked); the capture test reads the SHADOWED line (so a
  // trailing comment cannot defeat its end anchor).
  const shadowLines = shadowed.split('\n');
  const depths = functionDepths(shadowed);
  const hits = [];
  const lineAt = (index) => shadowed.slice(0, index).split('\n').length;

  // Class 1 — pollutable prototype METHOD calls: `arr.push(x)`.
  // Class 2 — dynamic invocation: `fn.call(…)` / `fn.apply(…)` read
  // Function.prototype.call at call time, so a script that overrides it reaches
  // every such site. ReflectApply (a captured static) is the fix.
  const callRe = /\.([A-Za-z]+)\s*\(/g;
  let m;
  while ((m = callRe.exec(shadowed)) !== null) {
    const kind = POLLUTABLE.has(m[1]) ? 'method' : INVOKE.has(m[1]) ? 'invoke' : null;
    if (kind === null) continue;
    hits.push({ line: lineAt(m.index), kind, name: `.${m[1]}(` });
  }

  // Class 3 — reads through a pollutable prototype ACCESSOR. This is the class
  // that let encoding.js sit at baseline 0 with a live vector: `view.buffer`
  // resolves through the configurable `%TypedArray%.prototype.buffer` getter,
  // and a poisoned getter substitutes an attacker's backing store. Only the
  // names below are counted — a blanket rule over every property read would be
  // noise, and a ratchet nobody can satisfy gets routed around.
  //
  // A trailing `(` means it is a call, not a read (`Buffer.byteLength(s)`), and
  // belongs to class 1/2 or to nothing.
  const accessorRe = /\.([A-Za-z_$][\w$]*)/g;
  while ((m = accessorRe.exec(shadowed)) !== null) {
    if (!ACCESSOR.has(m[1])) continue;
    const after = shadowed.slice(m.index + m[0].length).match(/^\s*/)[0].length;
    if (shadowed[m.index + m[0].length + after] === '(') continue;
    hits.push({ line: lineAt(m.index), kind: 'accessor', name: `.${m[1]}` });
  }

  // Class 4 — free reads of a replaceable global (`String(x)`, `Buffer.from`).
  // globalThis.String can be replaced by user code, so an internal module must
  // capture at module-eval — which the loader runs first — and use the capture.
  // The capture ITSELF is the fix, so `var StringG = String;` is exempt.
  // Matches every read form, not just `String(` and `String.`: a bare
  // `return String;` hands the live binding out, and `globalThis.String(x)`
  // reaches it the long way round. Both were missed until review of #321.
  const globalRe = /(^|[^.\w$])(globalThis\s*\.\s*)?([A-Za-z_$][\w$]*)/g;
  while ((m = globalRe.exec(shadowed)) !== null) {
    const name = m[3];
    if (!GLOBALS.has(name)) continue;
    const idx = m.index + m[1].length;
    const rest = shadowed.slice(idx + m[0].length - m[1].length);
    // `{ String: 1 }` is a key, not a read.
    if (/^\s*:/.test(rest)) continue;
    const line = lineAt(idx);
    // The capture exemption applies ONLY at module-eval depth. Inside a
    // function body the same line runs after user code and is a read.
    if (depths[idx] <= 1 && CAPTURE_RE.test(shadowLines[line - 1] || '')) continue;
    hits.push({ line, kind: 'global', name: m[2] ? `globalThis.${name}` : name });
  }

  return applySuppression(hits, origLines);
}

// `// primordials-ok` silences a line. Bare, it silences the line ONLY when
// every candidate on it belongs to a single class — otherwise a marker added
// for a known-safe `queue.push(x)` would also hide an unrelated live global
// read that the author never looked at. A mixed line must name its class:
// `// primordials-ok: method`.
function applySuppression(hits, origLines) {
  const byLine = new Map();
  for (const h of hits) {
    if (!byLine.has(h.line)) byLine.set(h.line, []);
    byLine.get(h.line).push(h);
  }
  const kept = [];
  for (const [line, lineHits] of byLine) {
    const marker = /\/\/\s*primordials-ok(?::\s*([\w,\s]+))?/.exec(origLines[line - 1] || '');
    if (!marker) {
      kept.push(...lineHits);
      continue;
    }
    const named = marker[1]
      ? marker[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    if (named) {
      kept.push(...lineHits.filter((h) => !named.includes(h.kind)));
      continue;
    }
    const classes = new Set(lineHits.map((h) => h.kind));
    // Bare marker on a mixed line suppresses nothing — make the author say which.
    kept.push(...(classes.size === 1 ? [] : lineHits));
  }
  kept.sort((a, b) => a.line - b.line);
  return { count: kept.length, hits: kept };
}

function countFile(file) {
  return countSource(readFileSync(file, 'utf8'));
}

// --- self-test -------------------------------------------------------------
//
// The ratchet is a security control, and a blind one is worse than none: it
// reports "OK" and a reviewer stops looking. encoding.js sat at baseline 0
// while carrying a live `%TypedArray%.prototype.buffer` poisoning vector,
// because the tool only ever counted METHOD calls. So the detector now proves
// itself on every run, against known-positive and known-negative fixtures, and
// refuses to report on the tree if any of them regresses.
//
// Fixtures are inline strings on purpose: a fixture FILE under the scanned
// directory would be counted as production source.
const SELF_TEST = [
  // Known positives — one per detector class.
  { name: 'method call', kind: 'method', src: 'arr.push(x);' },
  { name: 'accessor read', kind: 'accessor', src: 'var b = view.buffer;' },
  { name: 'byteOffset read', kind: 'accessor', src: 'f(v.byteOffset, v.byteLength);' },
  { name: 'constructor read', kind: 'accessor', src: 'var c = obj.constructor;' },
  { name: 'dynamic .call', kind: 'invoke', src: 'fn.call(thisArg, a);' },
  { name: 'dynamic .apply', kind: 'invoke', src: 'fn.apply(thisArg, args);' },
  { name: 'live global call', kind: 'global', src: 'function f() { return String(x); }' },
  { name: 'live global member', kind: 'global', src: 'function f() { return Buffer.from(x); }' },
  // `var b = Buffer.from(x)` starts like a capture but is a USE — the most
  // common shape of the vector, so it must not be exempted by the capture rule.
  { name: 'use that looks like a capture', kind: 'global', src: 'var b = Buffer.from(x);' },

  // Known negatives — these must NOT be counted, or the tool is unusable.
  { name: 'method in a comment', kind: null, src: '// arr.push(x)' },
  { name: 'method in a string', kind: null, src: 'var s = "arr.push(x)";' },
  { name: 'suppressed inline', kind: null, src: 'q.push(x); // primordials-ok' },
  // `.byteLength(` is a CALL, so it is not an accessor read. A captured
  // receiver keeps this fixture about that one question.
  { name: 'accessor name used as a call', kind: null, src: 'BufferG.byteLength(s);' },
  { name: 'capture is the fix', kind: null, src: 'var StringG = String;' },
  { name: 'member capture is the fix', kind: null, src: 'var BufferFrom = Buffer.from;' },
  { name: 'capture with trailing comment', kind: null, src: 'var S = String; // pristine' },
  { name: 'primordial wrapper call', kind: null, src: 'ArrayPrototypePush(arr, x);' },
  { name: 'ReflectApply is the fix', kind: null, src: 'ReflectApply(fn, null, args);' },

  // --- blind spots found in review of #321, each a way the detector could
  // report OK on a live vector. Every one is a positive; the negatives beside
  // them keep the fix from over-firing.

  // A capture is only the fix when it runs at MODULE-EVAL, before user code.
  // The same line inside a function body runs at call time — after a script has
  // had every chance to replace the global — so it is a read, not a capture.
  // Both fixtures carry the module wrapper every internal file has, because
  // that wrapper IS module-eval depth: the loader calls it once, before user
  // code. Depth 1 is therefore the exemption; the function nested inside it is
  // depth 2 and runs whenever it is called.
  {
    name: 'capture inside a function body',
    kind: 'global',
    src: '(function (require, module) {\n  function decode(x) {\n    const BufferFrom = Buffer.from;\n    return BufferFrom(x);\n  }\n})',
  },
  {
    name: 'capture at module level',
    kind: null,
    src: '(function (require, module) {\n  var BufferFrom = Buffer.from;\n})',
  },

  // shadow() blanked whole template literals, so anything inside `${…}` — which
  // executes — was invisible.
  { name: 'method in a template hole', kind: 'method', src: 'var s = `${arr.push(x)}`;' },
  { name: 'global in a template hole', kind: 'global', src: 'function f() { return `${String(y)}`; }' },
  { name: 'template text is still inert', kind: null, src: 'var s = `arr.push(x) String(y)`;' },

  // Documented live-read forms the global class did not match.
  { name: 'bare global read', kind: 'global', src: 'function f() { return String; }' },
  { name: 'qualified via globalThis', kind: 'global', src: 'function f() { return globalThis.String(x); }' },
  // NOT a fixture: `function f(String) { return String; }`. A local shadowing a
  // global name is counted, because deciding otherwise needs scope analysis the
  // scanner does not have. Conservative in the safe direction, and a local
  // named `String` inside a hardened module is its own problem.
  { name: 'object key is not a read', kind: null, src: 'var t = { __proto__: null, String: 1 };' },
];

// A bare `// primordials-ok` must not silence a class the author never looked
// at. Pinned separately because it is about the SUPPRESSION rule, not about a
// detector class: the marker is honoured only when every candidate on the line
// belongs to one class, so a mixed line has to name the class explicitly.
const SUPPRESSION_TEST = [
  { name: 'single-class line is suppressed', src: 'q.push(x); // primordials-ok', expect: 0 },
  // A bare marker on a mixed line suppresses NOTHING — not even the class the
  // author meant. Silencing only the global would be a guess, and silencing
  // both is the bug. The author has to name the class.
  {
    name: 'mixed line is NOT blanket-suppressed',
    src: 'function f() { q.push(x); String(y); } // primordials-ok',
    expect: 2,
  },
  {
    name: 'mixed line, class named explicitly',
    src: 'function f() { q.push(x); String(y); } // primordials-ok: method',
    expect: 1,
  },
];

function selfTest() {
  const failures = [];
  for (const t of SELF_TEST) {
    const { hits } = countSource(t.src);
    const got = hits.map((h) => h.kind);
    if (t.kind === null) {
      if (hits.length !== 0) failures.push(`${t.name}: expected no hit, got ${got.join(',')}`);
    } else if (!got.includes(t.kind)) {
      failures.push(`${t.name}: expected a '${t.kind}' hit, got ${got.length ? got.join(',') : 'none'}`);
    }
  }
  for (const t of SUPPRESSION_TEST) {
    const { hits } = countSource(t.src);
    if (hits.length !== t.expect) {
      failures.push(`${t.name}: expected ${t.expect} hit(s), got ${hits.length}`);
    }
  }
  return failures;
}

// Before anything else: a detector that has gone blind must not report on the
// tree. Exits non-zero rather than printing a reassuring "OK".
const selfTestFailures = selfTest();
if (selfTestFailures.length > 0) {
  console.error('Pollution ratchet SELF-TEST FAILED — the detector itself is broken:');
  for (const f of selfTestFailures) console.error(`  ${f}`);
  console.error(
    '\nEvery fixture above is a vector the ratchet is supposed to see. Fix the\n' +
      'detector before trusting any count it prints.',
  );
  process.exit(1);
}

const files = walk(JS_DIR).sort();
const counts = {};
const allHits = {};
for (const file of files) {
  const key = relative(JS_DIR, file).split(sep).join('/');
  const { hits } = countFile(file);
  // PER-CLASS counts, not one number. The classes differ by an order of
  // magnitude (globals outnumber everything else ~3:1 across the tree), and a
  // single total lets a file trade a fixed accessor for a new global and still
  // pass. Per class, "baseline 0" finally means something specific: encoding.js
  // is at 0 globals because it captures them, while its accessor count is not 0
  // and says so.
  const byKind = {};
  for (const k of KINDS) byKind[k] = 0;
  for (const h of hits) byKind[h.kind]++;
  counts[key] = byKind;
  allHits[key] = hits;
}

const sum = (byKind) => KINDS.reduce((a, k) => a + (byKind?.[k] ?? 0), 0);
const grandTotal = () => Object.values(counts).reduce((a, b) => a + sum(b), 0);

const update = process.argv.includes('--update');
if (update) {
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  const perKind = KINDS.map(
    (k) => `${k} ${Object.values(counts).reduce((a, b) => a + b[k], 0)}`,
  ).join(', ');
  console.log(
    `Wrote ${BASELINE} — ${grandTotal()} sites across ${files.length} files (${perKind}).`,
  );
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
  for (const kind of KINDS) {
    const now = counts[key][kind];
    // A pre-per-class baseline stored a bare number for the method class only;
    // treat a missing entry as 0 so a new class starts ratcheted at whatever it
    // is recorded to be, never at "anything goes".
    const base = typeof baseline[key] === 'number' ? (kind === 'method' ? baseline[key] : 0) : (baseline[key]?.[kind] ?? 0);
    if (now > base) {
      failed = true;
      console.error(`\n${key}: ${now} ${kind} sites, baseline ${base} (+${now - base}):`);
      for (const h of allHits[key].filter((h) => h.kind === kind)) {
        console.error(`  ${key}:${h.line}  ${h.name}`);
      }
    } else if (now < base) {
      improved = true;
      console.log(`${key}: ${kind} ${now} < baseline ${base} — hardened by ${base - now}.`);
    }
  }
}

if (failed) {
  console.error(
    '\nPollution ratchet FAILED: a module gained pollutable sites. The fix depends on\n' +
      "the class:  method/invoke -> route through primordials (require('primordials'),\n" +
      '            ReflectApply for .call/.apply)\n' +
      '            accessor     -> read via a captured getter, e.g.\n' +
      '                            TypedArrayPrototypeGetBuffer(view)\n' +
      '            global       -> capture at module-eval (`var StringG = String;`)\n' +
      'A genuine false positive (the receiver is a class instance, not a built-in) takes\n' +
      '`// primordials-ok` on the same line.',
  );
  process.exit(1);
}
if (improved) {
  console.log('\nRatchet improved — commit the tighter baseline:');
  console.log('  node scripts/check-primordials.mjs --update');
  process.exit(1);
}

const perKind = KINDS.map((k) => `${k} ${Object.values(counts).reduce((a, b) => a + b[k], 0)}`).join(
  ', ',
);
console.log(`OK: pollution ratchet holds (${grandTotal()} sites: ${perKind}).`);
