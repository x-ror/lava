// The ESM->CJS source transform must survive a poisoned intrinsic, on the carriers
// that decide what the emitted module BODY says.
//
// Why this is a differential and not a Lava-only pin. node's ESM loader is native
// C++ — none of the gadgets below reach it — so node is a real oracle here: it
// loads every fixture correctly under all six, and Lava must print the same bytes.
// That is stronger than a Lava-only test, because it pins Node parity at the same
// time. (Contrast tests/node-compat/cases/54-url-pollution.js, where the same logic
// applies for the same reason, and cmd/lava/regexp_pollution_test.odin, where it
// does NOT: undici's header validator is JavaScript, so node diverges there.)
//
// What is at stake is sharper than a wrong answer. The transform's output is
// EXECUTED SOURCE: `export default function foo` pulls the declared name out of a
// match group and interpolates it into the emitted CJS as an identifier. A forged
// group is therefore attacker-chosen code in the module body — measured, before the
// fix, as `pwned=CODE INJECTED` under the `targeted` probe below while node printed
// `pwned=undefined`. Reachability is ordinary: any CJS dependency required before
// the first `.mjs` can assign RegExp.prototype.exec.
//
// Each probe requires its OWN fixture. require() caches, so a shared fixture would
// be transformed once and every later probe would assert against a cache hit.
//
// Poison is restored before anything is printed: reading the result through a
// poisoned prototype would tell us nothing about the runtime.

function probe(label, poison, restore, run) {
  poison();
  let out;
  try {
    out = run();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    restore();
  }
  console.log(label + ' ' + out);
}

const realExec = RegExp.prototype.exec;
const realCharAt = String.prototype.charAt;
const realCharCodeAt = String.prototype.charCodeAt;
const realAt = Array.prototype.at;
const realStringify = JSON.stringify;
const realString = globalThis.String;

// 1. The blunt gadget: every regex answers with the same forged match. This is the
// shape #322 used, and it is the one a poisoned-`exec` dependency produces by
// accident rather than by aim.
probe(
  'blunt:',
  () => {
    const forged = ['forged', 'evil1', 'evil2', 'evil3'];
    forged.index = 0;
    forged.input = '';
    RegExp.prototype.exec = function () {
      return forged;
    };
  },
  () => {
    RegExp.prototype.exec = realExec;
  },
  () => {
    const m = require('../fixtures/esm-pollution/blunt.mjs');
    return [m.default(), m.named, new m.Widget().tag(), m.local].join('|');
  },
);

// 2. The aimed gadget, and the reason this file exists. It steers ONLY the
// `export default <decl>` name matcher and lets every other regex answer honestly,
// so the transform runs to completion and the forged group lands in the emitted
// body as code. `default` becoming a number is the visible half; the assignment to
// globalThis is the half that matters.
probe(
  'targeted:',
  () => {
    RegExp.prototype.exec = function (s) {
      const src = this.source;
      if (src.indexOf('function') !== -1 && src.indexOf('async') !== -1) {
        const forged = ['x', '0, (globalThis.__esm_pwned = "CODE INJECTED")'];
        forged.index = 0;
        forged.input = String(s);
        return forged;
      }
      return realExec.call(this, s);
    };
  },
  () => {
    RegExp.prototype.exec = realExec;
  },
  () => {
    const m = require('../fixtures/esm-pollution/targeted.mjs');
    return 'default=' + typeof m.default + ' pwned=' + globalThis.__esm_pwned;
  },
);

// 3. The adjacent carrier. Routing the transform off RegExp says nothing about what
// its scanner READS: buildMask decides what counts as string versus code with a live
// String.prototype.charAt, a writable data property like any other. Lying only about
// the quote characters makes string bodies scan as code, so statement-shaped text the
// module wrote as DATA gets spliced out and re-emitted.
probe(
  'charat:',
  () => {
    String.prototype.charAt = function (i) {
      const c = realCharAt.call(this, i);
      return c === '"' || c === "'" || c === '`' ? ' ' : c;
    };
  },
  () => {
    String.prototype.charAt = realCharAt;
  },
  () => {
    const m = require('../fixtures/esm-pollution/charat.mjs');
    return m.ok + ' pwned=' + globalThis.__esm_charat_pwned + ' doc=' + m.doc.length;
  },
);

// 3b. The carrier the fix for 3 moves ONTO. Reading code units instead of characters
// is only immune if the code-unit read is itself captured: `String.prototype.charCodeAt`
// is a writable data property exactly like charAt, which is how a hardened http.js
// still had response splitting in #322. Same narrow gadget, one representation down.
probe(
  'charcodeat:',
  () => {
    String.prototype.charCodeAt = function (i) {
      const c = realCharCodeAt.call(this, i);
      // 0x22 " · 0x27 ' · 0x60 ` — reported as 'x' so no string ever opens. A blanket
      // liar would break the runtime's own scanning and the probe would pass for an
      // unrelated reason.
      return c === 0x22 || c === 0x27 || c === 0x60 ? 0x78 : c;
    };
  },
  () => {
    String.prototype.charCodeAt = realCharCodeAt;
  },
  () => {
    const m = require('../fixtures/esm-pollution/charcodeat.mjs');
    return m.ok + ' pwned=' + globalThis.__esm_cca_pwned + ' doc=' + m.doc.length;
  },
);

// 4. The same invariant reached through the mask's mode STACK rather than its
// character reads. `stack.at(-1)` is an ordinary pollutable method; forcing it to
// answer "code" means the scanner never enters template mode.
probe(
  'arrayat:',
  () => {
    Array.prototype.at = function () {
      return { mode: 'code', brace: 0 };
    };
  },
  () => {
    Array.prototype.at = realAt;
  },
  () => {
    const m = require('../fixtures/esm-pollution/arrayat.mjs');
    return m.ok + ' tpl=' + m.tpl.length;
  },
);

// 5. Emission, not parsing. Every string literal the transform writes into its
// output — require specifiers, export keys, __filename/__dirname/import.meta.url —
// comes out of JSON.stringify, which is a writable property of an ordinary object.
probe(
  'json:',
  () => {
    JSON.stringify = function () {
      return '"POISONED"';
    };
  },
  () => {
    JSON.stringify = realStringify;
  },
  () => {
    const m = require('../fixtures/esm-pollution/json.mjs');
    return m.ok;
  },
);

// 6. The coercion beside it: jsonString runs String() over its argument first, and
// transform() coerces `source` the same way, so a replaced String global reaches the
// emitted literals AND the source text itself.
probe(
  'strglobal:',
  () => {
    globalThis.String = function () {
      return 'POISONED';
    };
  },
  () => {
    globalThis.String = realString;
  },
  () => {
    const m = require('../fixtures/esm-pollution/strglobal.mjs');
    return m.ok;
  },
);

// The control: with nothing poisoned the same shapes must still transform, so a
// "fix" that simply refuses to transform anything cannot pass this file.
const clean = require('../fixtures/esm-pollution/clean.mjs');
console.log('clean: ' + [clean.default(), clean.named, clean.local].join('|'));
