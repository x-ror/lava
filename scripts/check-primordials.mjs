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
//   method    `arr.push(x)`      — a pollutable prototype method, resolved live
//   invoke    `fn.call(t, a)`    — resolved through Function.prototype
//   accessor  `view.buffer`      — read through a configurable prototype getter
//   global    `String(x)`        — a replaceable global read live, not captured
//
// WHY AN AST. This was a regex scanner until it was measured. Three of the four
// classes are structural, not lexical, and the scanner got them wrong in both
// directions: 24% of its accessor hits were assignment TARGETS (a write counted
// as a read), every `global` hit in primordials.js was the capture table itself,
// every accessor hit in stream.js was the object's own `this.buffer` field — and
// `view['buffer']` was invisible, so rewriting `.buffer` to `['buffer']` LOWERED
// the count and the tool congratulated you for it. A ratchet that pays out for a
// rename is worse than none. It also could not see a brace inside a string
// inside a template hole, which desynchronised its shadowing and blanked the
// rest of the file — reporting a fully-blinded file as clean.
//
// acorn answers all of that exactly: parent links give callee-vs-read and
// write-vs-read, function nesting gives module-eval-vs-call-time with no
// heuristic, computed access with a literal key is just another property name,
// and `node.loc` gives line numbers that cannot drift. Reuse verdict (CLAUDE.md
// §2): acorn 8 + acorn-walk, MIT, pure JS with no transitive dependencies and no
// native binary, dev-only so `bin/lava` is unaffected, and `bun install` already
// runs in CI. `@oxlint/plugins` is present and was the alternative — rejected
// because oxlint documents `jsPlugins` as alpha and not semver-bound, and the
// ratchet would have to map lint diagnostics back into per-class counts.
//
// This tool still does NOT resolve types, so it cannot tell `array.push` from
// `simpleQueue.push`. It is a RATCHET: it counts syntactic sites per file per
// class and fails when a file exceeds its recorded baseline for that class.
// Hardening a module lowers a count; the tool then prints the tighter baseline
// to commit. A genuine false positive (the receiver is a class instance, not a
// built-in) takes `// primordials-ok` on the same line — honoured only inside a
// real line comment, and only when every candidate on the line shares one
// class. On a mixed line, name it: `// primordials-ok: method`, or a
// comma-separated list. An unrecognized class name suppresses nothing, so a typo
// fails loud.
//
// Per-class baselines are what make "0" mean something: a file may be at 0
// globals because it captures them and still carry accessor reads, and mixing
// the two into one number would let a fixed site pay for a new one.
//
// NOT covered, and deliberately:
//   * a fully dynamic member read (`var k = 'buffer'; view[k]`) — the key is not
//     in the source. A literal key IS counted.
//   * an object literal indexed by a caller-supplied key needs `__proto__: null`
//     (CLAUDE.md §5, the "One class is still on you" bullet). Deciding a literal
//     is a dynamic-key lookup table takes dataflow.
//   * the iterator / thenable / coercion protocols (`for…of`, `await` on a
//     poisoned `Object.prototype.then`, `Symbol.toPrimitive`) — these read a
//     well-known symbol, not a named property, so there is no name to count.
//     `Object.prototype.then` in particular is a plain data property reachable
//     by an ordinary merge gadget; it is the sharpest uncounted vector and is
//     recorded in ROADMAP rather than implied to be handled.
//
// Usage:
//   node scripts/check-primordials.mjs                  # check against baseline
//   node scripts/check-primordials.mjs --update         # lower the baseline
//   node scripts/check-primordials.mjs --update --allow-raise
//
// Exit 1 if any file exceeds its baseline, or if a count dropped (commit the
// tighter baseline), or if the detector's own self-test fails.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = join(import.meta.dirname, '..');
// The PARENT of internal/: console.js sits directly in pkg/runtime/js, is
// #load-embedded by globals.odin, and runs before user code exactly like the
// internal modules — it was outside the scan while the baseline's "console.js"
// entry described the 7-line internal re-export, so the report read as "console
// is hardened". check-orphan-js.mjs already walks this directory.
const JS_DIR = join(ROOT, 'pkg', 'runtime', 'js');
const BASELINE = join(ROOT, 'tests', 'node-compat', 'pollution-baseline.json');

// The detector classes, in report order. Each is counted and baselined
// SEPARATELY — see the note at the counting loop.
const KINDS = ['method', 'invoke', 'accessor', 'global'];

// Pollutable prototype methods. Array/String mutators plus the prototypes a
// poisoned method on which has a demonstrated consequence in this codebase:
//   RegExp  `test`/`exec` — writable DATA properties, no defineProperty needed.
//           A poisoned `test` makes fetch.js's VALID_HEADER_NAME accept a name
//           containing CRLF (header injection, reproduced on the wire) and makes
//           http.js read Content-Length as NaN (request smuggling desync).
//   Promise `then`/`catch` — every internal await and .then chain.
//   Function `bind`, TypedArray `subarray`, Object `toString`/`valueOf`/
//           `hasOwnProperty` — all writable, all with a primordial available.
// `.at` and `.normalize` carry the two worst known URL vectors (IPv4
// normalization bypass, host substitution).
const POLLUTABLE = new Set([
  // Array.prototype
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'slice',
  'concat',
  'join',
  'reverse',
  'sort',
  'map',
  'filter',
  'forEach',
  'reduce',
  'reduceRight',
  'indexOf',
  'lastIndexOf',
  'includes',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'some',
  'every',
  'flat',
  'flatMap',
  'fill',
  'copyWithin',
  'entries',
  'keys',
  'values',
  'at',
  // String.prototype
  'charCodeAt',
  'codePointAt',
  'charAt',
  'replace',
  'replaceAll',
  'split',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'normalize',
  'localeCompare',
  'match',
  'matchAll',
  'search',
  'substr',
  'substring',
  // RegExp.prototype
  'test',
  'exec',
  // Promise.prototype
  'then',
  'catch',
  // Function.prototype / %TypedArray%.prototype / Object.prototype
  'bind',
  'subarray',
  'toString',
  'valueOf',
  'hasOwnProperty',
]);

// Dynamic invocation: resolved through Function.prototype at call time.
const INVOKE = new Set(['call', 'apply']);

// Prototype ACCESSORS worth counting. Deliberately a short list of names that
// are (a) reachable through a configurable prototype getter and (b) rare enough
// as ordinary property names that the false-positive rate stays low.
//
// `length` is NOT here, and that was traced rather than assumed: a poisoned
// %TypedArray%.prototype.length getter cannot widen a view, because every
// native re-derives the real byte length from the engine's internal slots
// (typed_array_view, pkg/runtime/typed_array.odin), so the outcome is
// truncation rather than an over-read. The disclosure axis is byteOffset and
// byteLength, which ARE counted. Counting `length` would fire on every
// `arr.length` and make the ratchet unusable, which is its own failure mode.
const ACCESSOR = new Set(['buffer', 'byteOffset', 'byteLength', 'constructor', '__proto__']);

// Globals a script can replace outright. Captured at module-eval, these are
// safe; read live inside a function body they are the `global` class.
const GLOBALS = new Set([
  'String',
  'Number',
  'Boolean',
  'Object',
  'Array',
  'Symbol',
  'Promise',
  'Reflect',
  'JSON',
  'Math',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'Buffer',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Date',
  'Proxy',
]);

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

// The property name a member expression reads, or null when the key is not in
// the source. `view.buffer` and `view['buffer']` are the same read and both
// return 'buffer'; `view[k]` returns null (see the header's NOT-covered list).
function propName(node) {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

// How many function bodies enclose this node. The module wrapper every internal
// file is written inside counts as 1, so depth <= 1 is module-eval — code the
// loader runs before any user code — and anything deeper runs at call time.
function functionDepth(ancestors) {
  let n = 0;
  for (const a of ancestors) if (FUNCTION_TYPES.has(a.type)) n++;
  return n;
}

// A global read AT MODULE-EVAL is not a finding at all — the loader evaluates
// module bodies before any user code runs, so the binding it reads is still
// pristine. That is what makes a capture the fix, and it generalises: the shape
// of the statement does not matter, only when it runs. `var S = String;`,
// `module.exports = { Object: Object }` and even `var b = Buffer.from(x)` are all
// safe at depth <= 1, and all three are live reads at depth >= 2.
//
// This replaced a line-shaped "is it a capture?" regex, which had to guess and
// guessed wrong in both directions: it exempted a capture inside a function body
// (a call-time read) and counted primordials.js's export table (73 module-level
// mentions that are the capture itself).
function runsAtModuleEval(ancestors) {
  return functionDepth(ancestors) <= 1;
}

// Does an enclosing function bind this name as a parameter? `function f(String)`
// shadows the global, so the body's `String` is a local, not a live global read.
function shadowedByParam(name, ancestors) {
  for (const a of ancestors) {
    if (!FUNCTION_TYPES.has(a.type)) continue;
    for (const p of a.params) {
      if (p.type === 'Identifier' && p.name === name) return true;
    }
  }
  return false;
}

// countSource parses `src` and reports every pollutable site, per class, with the
// line each sits on. Throws when the source does not parse — a scanner that
// silently reports 0 sites on a file it failed to read is the failure mode this
// tool exists to prevent.
function countSource(src, label = '<fixture>') {
  const lineComments = new Map();
  let ast;
  try {
    ast = parse(src, {
      ecmaVersion: 2023,
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      onComment: (isBlock, text, _s, _e, locStart) => {
        // Only a LINE comment carries a suppression marker, and only a real
        // comment does: the previous implementation matched the marker text
        // anywhere on the raw line, so `var s = "// primordials-ok";` silenced
        // the line.
        if (!isBlock) lineComments.set(locStart.line, text);
      },
    });
  } catch (err) {
    throw new Error(`${label}: parse failed at line ${err.loc?.line ?? '?'}: ${err.message}`);
  }

  const hits = [];
  const at = (node, kind, name) => hits.push({ line: node.loc.start.line, kind, name });

  walk.ancestor(ast, {
    MemberExpression(node, _state, ancestors) {
      const name = propName(node);
      if (name === null) return;
      const parent = ancestors[ancestors.length - 2];
      const isWrite =
        parent &&
        ((parent.type === 'AssignmentExpression' && parent.left === node) ||
          (parent.type === 'UpdateExpression' && parent.argument === node));
      // A write does not resolve a getter, so it is not a pollutable read.
      // `Stream.prototype.constructor = Stream` was 24% of the old accessor count.
      if (isWrite) return;

      // `globalThis.String(x)` reaches the same replaceable binding the long way
      // round. Handled HERE rather than in the Identifier visitor because
      // acorn-walk only descends into `property` when the access is computed, so
      // a non-computed property identifier is never visited on its own.
      if (
        node.object.type === 'Identifier' &&
        node.object.name === 'globalThis' &&
        GLOBALS.has(name)
      ) {
        if (!runsAtModuleEval(ancestors)) at(node, 'global', `globalThis.${name}`);
        return;
      }

      const isCallee =
        parent &&
        (parent.type === 'CallExpression' || parent.type === 'NewExpression') &&
        parent.callee === node;

      if (isCallee) {
        if (POLLUTABLE.has(name)) at(node, 'method', `.${name}()`);
        else if (INVOKE.has(name)) at(node, 'invoke', `.${name}()`);
      }
      if (!ACCESSOR.has(name)) return;
      // A static call on a global constructor (`Buffer.byteLength(s)`) reads the
      // constructor's own property, not a view's prototype getter.
      if (node.object.type === 'Identifier' && GLOBALS.has(node.object.name)) return;
      // `this.buffer` is the object's own field — every accessor hit in
      // stream.js was this shape.
      if (node.object.type === 'ThisExpression') return;
      // A callee position is still a READ of the accessor: `new v.constructor(…)`
      // reaches the prototype chain and then invokes whatever it found. The old
      // trailing-`(` rule skipped it, which hid a reproduced vector in
      // structured_clone.js.
      at(node, 'accessor', `.${name}`);
    },

    // `const { buffer } = view` resolves the same getter as `view.buffer`.
    ObjectPattern(node) {
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.computed) continue;
        const key = p.key.type === 'Identifier' ? p.key.name : null;
        if (key && ACCESSOR.has(key)) at(p, 'accessor', `{ ${key} } =`);
      }
    },

    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // `globalThis.String(x)` reaches the same replaceable binding the long way.
      if (
        parent.type === 'MemberExpression' &&
        parent.property === node &&
        parent.object.type === 'Identifier' &&
        parent.object.name === 'globalThis' &&
        GLOBALS.has(node.name)
      ) {
        at(node, 'global', `globalThis.${node.name}`);
        return;
      }
      if (!GLOBALS.has(node.name)) return;
      // Property, key, label and binding positions are not reads of the global.
      if (parent.type === 'MemberExpression' && parent.property === node) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'VariableDeclarator' && parent.id === node) return;
      if (FUNCTION_TYPES.has(parent.type) && (parent.id === node || parent.params.includes(node))) {
        return;
      }
      if (parent.type === 'ClassDeclaration' && parent.id === node) return;
      if (shadowedByParam(node.name, ancestors)) return;
      if (runsAtModuleEval(ancestors)) return;
      at(node, 'global', node.name);
    },
  });

  hits.sort((a, b) => a.line - b.line);
  return applySuppression(hits, lineComments);
}

// `// primordials-ok` silences a line. Bare, it silences the line ONLY when
// every candidate on it belongs to a single class — otherwise a marker added for
// a known-safe `queue.push(x)` would also hide an unrelated live global read the
// author never looked at. A mixed line must name its class:
// `// primordials-ok: method` (or a comma-separated list). An unrecognized name
// suppresses nothing, so a typo fails loud rather than quiet.
function applySuppression(hits, lineComments) {
  const byLine = new Map();
  for (const h of hits) {
    if (!byLine.has(h.line)) byLine.set(h.line, []);
    byLine.get(h.line).push(h);
  }
  const kept = [];
  for (const [line, lineHits] of byLine) {
    const comment = lineComments.get(line);
    const marker = comment ? /^\s*primordials-ok(?::\s*([\w,\s]+))?/.exec(comment) : null;
    if (!marker) {
      kept.push(...lineHits);
      continue;
    }
    if (marker[1]) {
      const named = marker[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      kept.push(...lineHits.filter((h) => !named.includes(h.kind)));
      continue;
    }
    const classes = new Set(lineHits.map((h) => h.kind));
    kept.push(...(classes.size === 1 ? [] : lineHits));
  }
  kept.sort((a, b) => a.line - b.line);
  return { count: kept.length, hits: kept };
}

function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

function countFile(file) {
  return countSource(readFileSync(file, 'utf8'), relative(ROOT, file));
}

// --- self-test -------------------------------------------------------------
//
// The ratchet is a security control, and a blind one is worse than none: it
// reports "OK" and a reviewer stops looking. So the detector proves itself on
// every run against fixtures with EXACT per-class expectations, and refuses to
// report on the tree if any of them regresses.
//
// Exact counts, not "includes": an `includes` assertion passes while the
// detector also over-fires, which is how a `length`-in-ACCESSOR regression and a
// double-count both slipped past the previous harness.
//
// Fixtures are inline strings on purpose: a fixture FILE under the scanned
// directory would be counted as production source.
const E = (o = {}) => ({ method: 0, invoke: 0, accessor: 0, global: 0, ...o });
const WRAP = (body) => `(function (require, module) {\n${body}\n})`;

const SELF_TEST = [
  // --- the four classes, each in its plainest form ---
  { name: 'method call', src: 'arr.push(x);', expect: E({ method: 1 }) },
  { name: 'accessor read', src: 'var b = view.buffer;', expect: E({ accessor: 1 }) },
  { name: 'two accessor reads', src: 'f(v.byteOffset, v.byteLength);', expect: E({ accessor: 2 }) },
  { name: 'dynamic .call', src: 'fn.call(thisArg, a);', expect: E({ invoke: 1 }) },
  { name: 'dynamic .apply', src: 'fn.apply(thisArg, args);', expect: E({ invoke: 1 }) },
  {
    name: 'live global call',
    src: WRAP('function f() { return String(x); }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'bare global read',
    src: WRAP('function f() { return String; }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'qualified via globalThis',
    src: WRAP('function f() { return globalThis.String(x); }'),
    expect: E({ global: 1 }),
  },

  // --- the prototypes added after a reproduced exploit ---
  // A poisoned RegExp.prototype.test let a CRLF-bearing header name through
  // fetch.js's validator and onto the wire, and made http.js read
  // Content-Length as NaN (smuggling desync). Both are writable data properties.
  {
    name: 'RegExp test is pollutable',
    src: 'if (RE.test(name)) return;',
    expect: E({ method: 1 }),
  },
  { name: 'RegExp exec is pollutable', src: 'var m = RE.exec(s);', expect: E({ method: 1 }) },
  { name: 'Promise then is pollutable', src: 'p.then(f);', expect: E({ method: 1 }) },

  // --- read vs write vs callee: the structural distinctions a scanner got wrong ---
  // A write does not resolve a getter. This was 24% of the old accessor count.
  // `Stream` is not a counted global, so a correct detector reports NOTHING here
  // — the point is that `.constructor` on the left of `=` is a write.
  {
    name: 'assignment target is not a read',
    src: 'Stream.prototype.constructor = Stream;',
    expect: E(),
  },
  {
    name: 'accessor write via a global receiver',
    src: WRAP('function f(g) { Object.prototype.toString = g; }'),
    expect: E({ global: 1 }),
  },
  // `new v.constructor(…)` DOES reach the prototype chain — the old trailing-"("
  // rule skipped it and hid a reproduced structured_clone.js vector.
  {
    name: 'constructor as a callee is a read',
    src: 'var v = new value.constructor(buf, 0, n);',
    expect: E({ accessor: 1 }),
  },
  // A static call on a global constructor reads the constructor's own property.
  {
    name: 'static call on a global',
    src: WRAP('function f() { return Buffer.byteLength(s); }'),
    expect: E({ global: 1 }),
  },
  // `this.buffer` is the object's own field — every stream.js accessor hit.
  { name: 'own field via this', src: WRAP('function f() { return this.buffer; }'), expect: E() },

  // --- computed and destructured reads: the ratchet must not pay for a rename ---
  { name: 'computed accessor read', src: "var b = view['buffer'];", expect: E({ accessor: 1 }) },
  { name: 'computed method call', src: "arr['push'](x);", expect: E({ method: 1 }) },
  { name: 'destructured accessor read', src: 'var { buffer } = view;', expect: E({ accessor: 1 }) },
  // A fully dynamic key is not in the source — documented as not covered.
  { name: 'fully dynamic key is not counted', src: 'var b = view[k];', expect: E() },

  // --- the capture exemption, which is only sound at module-eval ---
  { name: 'capture at module level', src: WRAP('  var BufferFrom = Buffer.from;'), expect: E() },
  {
    name: 'capture inside a function body',
    src: WRAP(
      '  function d(x) {\n    const BufferFrom = Buffer.from;\n    return BufferFrom(x);\n  }',
    ),
    expect: E({ global: 1 }),
  },
  // The arrow form: the old 3-char lookback missed `=>` followed by a newline,
  // which re-opened the very blind spot it was written to close.
  {
    name: 'capture inside an arrow body',
    src: WRAP(
      '  var d = (x) =>\n  {\n    const BufferFrom = Buffer.from;\n    return BufferFrom(x);\n  };',
    ),
    expect: E({ global: 1 }),
  },
  {
    // At module-eval the SHAPE does not matter — a capture and a use both read a
    // pristine binding, because the loader runs the module body before user
    // code. Inside a function both are live reads. That is why the detector
    // asks "when does this run", not "does this line look like a capture".
    name: 'use at module level is safe',
    src: WRAP('  var b = Buffer.from(x);'),
    expect: E(),
  },
  {
    name: 'the same use inside a function',
    src: WRAP('function f() { var b = Buffer.from(x); return b; }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'export table is the capture',
    src: WRAP('  module.exports = { Object: Object, Array: Array };'),
    expect: E(),
  },

  // --- positions that are not reads at all ---
  { name: 'object key is not a read', src: 'var t = { __proto__: null, String: 1 };', expect: E() },
  {
    name: 'ternary reads both globals',
    src: WRAP('function f(c) { return c ? String : Number; }'),
    expect: E({ global: 2 }),
  },
  {
    name: 'case label is a read',
    src: WRAP('function f(x) { switch (x) { case String: return 1; } }'),
    expect: E({ global: 1 }),
  },
  {
    name: 'param shadows the global',
    src: WRAP('function f(String) { return String; }'),
    expect: E(),
  },
  { name: '__proto__ read', src: 'var p = obj.__proto__;', expect: E({ accessor: 1 }) },
  { name: 'primordial wrapper call', src: 'ArrayPrototypePush(arr, x);', expect: E() },
  { name: 'ReflectApply is the fix', src: 'ReflectApply(fn, null, args);', expect: E() },

  // --- lexical contexts: inert text must stay inert, executable text must not ---
  { name: 'method in a comment', src: '// arr.push(x)', expect: E() },
  { name: 'method in a string', src: 'var s = "arr.push(x)";', expect: E() },
  {
    name: 'escaped quote keeps the string inert',
    src: 'var s = "a \\" arr.push(x) \\" b";',
    expect: E(),
  },
  { name: 'regex literal is inert', src: 'var re = /\\.push\\(|String/;', expect: E() },
  {
    name: 'division is not a regex',
    src: WRAP('function f() { var h = len / 2; return String(h); }'),
    expect: E({ global: 1 }),
  },
  // A template HOLE executes; the literal text around it does not.
  { name: 'method in a template hole', src: 'var s = `${arr.push(x)}`;', expect: E({ method: 1 }) },
  {
    name: 'global in a template hole',
    src: WRAP('function f() { return `${String(y)}`; }'),
    expect: E({ global: 1 }),
  },
  { name: 'template text is inert', src: 'var s = `arr.push(x) String(y)`;', expect: E() },
  // A brace inside a string inside a hole desynchronised the old shadower and
  // blanked the REST OF THE FILE, reporting a blinded file as clean.
  {
    name: 'brace in a hole string does not blind the rest',
    src: "var t = `${ o['}'] }`;\narr.push(x);",
    expect: E({ method: 1 }),
  },
  {
    name: 'regex after return does not blind the rest',
    src: WRAP('function f(s) { return /[\'"]/.test(s); }\nfunction g() { arr.push(x); }'),
    expect: E({ method: 2 }),
  },

  // --- line attribution, which suppression depends on ---
  {
    name: 'line survives a multiline template',
    src: 'var m = `${a}\n${b}`;\narr.push(x);',
    expectLine: 3,
    expect: E({ method: 1 }),
  },

  // --- suppression ---
  { name: 'single-class line is suppressed', src: 'q.push(x); // primordials-ok', expect: E() },
  {
    name: 'marker inside a string does not suppress',
    src: 'function f(){ q.push(x); var s = "// primordials-ok"; }',
    expect: E({ method: 1 }),
  },
  {
    name: 'mixed line is not blanket-suppressed',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok'),
    expect: E({ method: 1, global: 1 }),
  },
  {
    name: 'mixed line, one class named',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok: method'),
    expect: E({ global: 1 }),
  },
  {
    name: 'mixed line, both classes named',
    src: WRAP('function f() { q.push(x); String(y); } // primordials-ok: method, global'),
    expect: E(),
  },
  {
    name: 'unknown class name suppresses nothing',
    src: 'q.push(x); // primordials-ok: methods',
    expect: E({ method: 1 }),
  },
];

function selfTest() {
  const failures = [];
  for (const t of SELF_TEST) {
    let got;
    try {
      got = countSource(t.src, t.name);
    } catch (err) {
      failures.push(`${t.name}: ${err.message}`);
      continue;
    }
    const actual = E();
    for (const h of got.hits) actual[h.kind]++;
    for (const kind of KINDS) {
      if (actual[kind] !== t.expect[kind]) {
        failures.push(
          `${t.name}: expected ${t.expect[kind]} ${kind}, got ${actual[kind]}` +
            ` (all: ${KINDS.map((k) => `${k} ${actual[k]}`).join(', ')})`,
        );
      }
    }
    if (t.expectLine !== undefined && got.hits.length > 0 && got.hits[0].line !== t.expectLine) {
      failures.push(`${t.name}: expected the hit on line ${t.expectLine}, got ${got.hits[0].line}`);
    }
  }
  return failures;
}

// --- report ----------------------------------------------------------------

// Before anything else: a detector that has gone blind must not report on the
// tree, and must not be allowed to rebaseline. Exits non-zero rather than
// printing a reassuring "OK".
const selfTestFailures = selfTest();
if (selfTestFailures.length > 0) {
  console.error('Pollution ratchet SELF-TEST FAILED — the detector itself is broken:');
  for (const f of selfTestFailures) console.error(`  ${f}`);
  console.error(
    '\nEvery fixture above pins a vector the ratchet is supposed to see, or a\n' +
      'position it must not count. Fix the detector before trusting any number it\n' +
      'prints.',
  );
  process.exit(1);
}

const files = walkDir(JS_DIR).sort();
const counts = {};
const allHits = {};
for (const file of files) {
  const key = relative(JS_DIR, file).split(sep).join('/');
  const { hits } = countFile(file);
  // PER-CLASS counts, not one number. The classes differ by an order of
  // magnitude, and a single total would let a file trade a fixed accessor for a
  // new global and still pass.
  const byKind = {};
  for (const k of KINDS) byKind[k] = 0;
  for (const h of hits) byKind[h.kind]++;
  counts[key] = byKind;
  allHits[key] = hits;
}

const perKindLine = () =>
  KINDS.map((k) => `${k} ${Object.values(counts).reduce((a, b) => a + b[k], 0)}`).join(', ');
const grandTotal = () =>
  Object.values(counts).reduce((a, b) => a + KINDS.reduce((s, k) => s + b[k], 0), 0);

let baseline = {};
let haveBaseline = true;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
} catch {
  haveBaseline = false;
}

const update = process.argv.includes('--update');
if (update) {
  // A raise is a policy decision, not a mechanical one: the point of the ratchet
  // is that a floor only moves down. Previously `--update` rewrote every entry in
  // both directions, so a contributor who hit a failure and reached for
  // `UPDATE=1` silently raised the floor for every file — the prose rule in
  // CLAUDE.md §5 was the only thing stopping it.
  const raises = [];
  if (haveBaseline) {
    for (const key of Object.keys(counts)) {
      for (const kind of KINDS) {
        const base = baseline[key]?.[kind] ?? 0;
        if (counts[key][kind] > base) {
          raises.push(
            `  ${key}: ${kind} ${base} -> ${counts[key][kind]} (+${counts[key][kind] - base})`,
          );
        }
      }
    }
  }
  if (raises.length > 0 && !process.argv.includes('--allow-raise')) {
    console.error('Refusing to RAISE the baseline. These entries would go up:\n');
    for (const r of raises) console.error(r);
    console.error(
      '\nThe ratchet only moves down. Harden the sites, add `// primordials-ok` where\n' +
        'the receiver genuinely is not a built-in, or pass --allow-raise if you are\n' +
        'deliberately recording new ground (a newly scanned file, or a new class).',
    );
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log(
    `Wrote ${BASELINE} — ${grandTotal()} sites across ${files.length} files (${perKindLine()}).`,
  );
  process.exit(0);
}

if (!haveBaseline) {
  console.error(`No baseline at ${BASELINE}. Run: node scripts/check-primordials.mjs --update`);
  process.exit(1);
}

let failed = false;
let improved = false;
for (const key of Object.keys(counts)) {
  for (const kind of KINDS) {
    const now = counts[key][kind];
    // A file absent from the baseline starts at 0 in every class, so a new
    // unhardened module cannot land silently.
    const base = baseline[key]?.[kind] ?? 0;
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
      '`// primordials-ok` on the same line. On a line carrying candidates from more\n' +
      'than one class the bare marker suppresses nothing — name it:\n' +
      '`// primordials-ok: method`.',
  );
  process.exit(1);
}
if (improved) {
  console.log('\nRatchet improved — commit the tighter baseline:');
  console.log('  node scripts/check-primordials.mjs --update');
  process.exit(1);
}

console.log(`OK: pollution ratchet holds (${grandTotal()} sites: ${perKindLine()}).`);
