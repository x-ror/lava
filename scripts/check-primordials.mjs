// Prototype-pollution ratchet — CLI entry point.
//
// The detector lives in lib/primordials-detect.mjs and its fixtures in
// lib/primordials-fixtures.mjs; this file is the baseline comparison, the
// --update path, and the report. See the detector for what each class means
// and why the tool parses rather than scans.
//
// Usage:
//   node scripts/check-primordials.mjs                  # check against baseline
//   node scripts/check-primordials.mjs --update         # lower the baseline
//   node scripts/check-primordials.mjs --update --allow-raise

import { readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { KINDS, countFile, walkDir, JS_DIR, BASELINE } from './lib/primordials-detect.mjs';
import { selfTest } from './lib/primordials-fixtures.mjs';

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
