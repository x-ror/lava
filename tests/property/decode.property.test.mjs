// Differential PROPERTY tests: for any input, Lava's answer must equal Node's.
//
// The repo's oracle model is already "same script, both runtimes, byte-identical
// output" — this generates the inputs instead of hand-picking them, because every
// decoder defect found across #320/#321 was an edge case somebody either happened
// to pick or happened to miss: `-0` in an error tail, the 0x2000 chunk boundary, a
// lone surrogate, a brace inside a template hole.
//
// BATCHED, and that is what makes it worth running. Spawning a node+lava pair per
// generated input cost 39.6 ms per assertion — 3200 process launches for 1800
// comparisons, 64 seconds — and that budget, not a coverage judgement, was what
// held the corpus at 200 inputs. Materializing the corpus with `fc.sample` and
// handing the whole list to ONE process pair per property is ~176x cheaper, so the
// default is 5000 inputs in about a second. The difference is not academic: at 200
// the suite passed clean, and at 5000 it found a real utf-16le divergence (an
// unpaired lead surrogate followed by an odd trailing byte emitted two U+FFFD
// where the spec and Node emit one).
//
// Shrinking is preserved: on a mismatch the failing input is re-entered through
// `fc.assert` one input at a time, so the reported counterexample is minimal.
//
// fast-check stays on the Node side and drives `bin/lava` as a subprocess.
// Requiring it inside Lava would test Lava's module resolution against a dual
// ESM/CJS package rather than the decoder; only bytes cross, via stdin.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const LAVA = process.env.LAVA_BIN ?? join(ROOT, 'bin', 'lava');
const NODE = process.env.NODE_BIN ?? process.execPath;

// A fixed seed keeps a failure reproducible — "it passed on my machine" is not a
// possibility. Raise for a deeper local sweep; the committed value is what the
// batched design can afford in CI.
const RUNS = Number(process.env.PROPERTY_RUNS ?? 5000);
const SEED = 20260730;

const toHex = (u8) => Buffer.from(u8).toString('hex');

const SCRATCH = mkdtempSync(join(tmpdir(), 'lava-prop-'));
let corpusSeq = 0;

// One process per runtime per property. The corpus goes through a FILE rather
// than stdin or argv: `lava eval` does not read stdin, and 5000 hex strings
// overflow a comfortable argv/env budget.
function runBatch(bin, args, script, corpus, env) {
  const path = join(SCRATCH, `corpus-${corpusSeq++}.txt`);
  writeFileSync(path, corpus.join('\n') + '\n');
  const out = execFileSync(bin, [...args, script], {
    env: { ...process.env, ...env, PROP_CORPUS: path },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The batch driver every property script shares: read stdin, map each hex line
// through `decodeLine`, print one line per input. Kept as a string because both
// runtimes evaluate it — `lava eval` and `node -e` are the two entry points the
// oracle model already uses.
const DRIVER = (body) => `
  var lines = require('fs').readFileSync(process.env.PROP_CORPUS, 'utf8').split('\\n');
  // Drop ONLY the trailing empty element the final newline produces. An interior
  // empty line is a legitimate input — the empty byte sequence — and skipping
  // those desynchronises every later result from its label.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  var out = [];
  for (var i = 0; i < lines.length; i++) out.push(${body});
  console.log(out.join('\\n'));
`;

// `one(hex)` is the per-input expression. It must be total: a thrown error is a
// legitimate result and is reported as text, so a divergence in WHICH input throws
// is caught rather than crashing the batch.
// Every result is prefixed, so a result that is itself empty cannot be mistaken
// for the trailing newline on the way back.
const guarded = (expr) => `'=' + (function (hex) {
    try { return ${expr}; } catch (e) { return 'THREW ' + e.name; }
  })(lines[i])`;

const DECODE = DRIVER(
  guarded(`JSON.stringify(
    new TextDecoder(process.env.PROP_ENC, { fatal: process.env.PROP_FATAL === '1' })
      .decode(Buffer.from(hex, 'hex')),
  )`),
);

// A NONZERO byteOffset, which the previous per-input design never produced: a
// fresh process's first pooled allocation always sat at offset 0, so the fast
// path's offset arithmetic was never exercised and even `base + off` -> `off`
// survived the suite.
const DECODE_OFFSET = DRIVER(
  guarded(`(function () {
    // subarray() guarantees a nonzero offset RELATIVE to the backing buffer,
    // which is what the fast path's arithmetic sees. The absolute pool offset is
    // deliberately not compared: node's pooled Buffer.from lands at a nonzero
    // offset and Lava's at 0, and node's own varies run to run, so it is not
    // pinnable and says nothing about the decoder.
    var b = Buffer.from(hex, 'hex');
    var skip = b.length > 3 ? 3 : 0;
    return JSON.stringify(new TextDecoder().decode(b.subarray(skip)));
  })()`),
);

const STREAM = DRIVER(
  guarded(`(function () {
    var b = Buffer.from(hex, 'hex');
    var at = b.length ? hex.length % (b.length + 1) : 0;
    var d = new TextDecoder(process.env.PROP_ENC);
    return JSON.stringify(
      d.decode(b.subarray(0, at), { stream: true }) + d.decode(b.subarray(at)),
    );
  })()`),
);

const ROUNDTRIP = DRIVER(
  guarded(`JSON.stringify(
    new TextDecoder().decode(new TextEncoder().encode(Buffer.from(hex, 'hex').toString('utf16le'))),
  )`),
);

// Compare a whole corpus, then shrink only if something differed.
function differential(t, script, corpus, env, generator) {
  const fromNode = runBatch(NODE, ['-e'], script, corpus, env);
  const fromLava = runBatch(LAVA, ['eval'], script, corpus, env);
  assert.equal(fromLava.length, corpus.length, 'lava produced the wrong number of result lines');
  assert.equal(fromNode.length, corpus.length, 'node produced the wrong number of result lines');

  const bad = [];
  for (let i = 0; i < corpus.length; i++) {
    if (fromLava[i] !== fromNode[i]) bad.push(i);
  }
  if (bad.length === 0) return;

  // Re-enter fast-check on the failing inputs so the counterexample it reports is
  // minimal rather than whatever length the generator happened to produce.
  const failing = new Set(bad.map((i) => corpus[i]));
  t.diagnostic(`${bad.length}/${corpus.length} mismatched; shrinking`);
  fc.assert(
    fc.property(generator, (u8) => {
      const hex = toHex(u8);
      if (!failing.has(hex)) return;
      const n = runBatch(NODE, ['-e'], script, [hex], env)[0];
      const l = runBatch(LAVA, ['eval'], script, [hex], env)[0];
      assert.equal(l, n, `bytes: ${hex || '(empty)'}`);
    }),
    { seed: SEED, numRuns: RUNS, endOnFailure: true },
  );
  // Shrinking found nothing reproducible on its own — report the first raw diff.
  const i = bad[0];
  assert.equal(fromLava[i], fromNode[i], `bytes: ${corpus[i] || '(empty)'}`);
}

const bytesGen = fc.uint8Array({ maxLength: 96 });
const corpus = fc.sample(bytesGen, { seed: SEED, numRuns: RUNS }).map(toHex);

for (const enc of ['utf-8', 'utf-16le', 'windows-1252']) {
  for (const fatal of [false, true]) {
    test(`decode ${enc}${fatal ? ' fatal' : ''} matches node`, (t) => {
      differential(t, DECODE, corpus, { PROP_ENC: enc, PROP_FATAL: fatal ? '1' : '0' }, bytesGen);
    });
  }
}

test('decode at a nonzero byteOffset matches node', (t) => {
  differential(t, DECODE_OFFSET, corpus, {}, bytesGen);
});

for (const enc of ['utf-8', 'utf-16le']) {
  test(`streaming ${enc} matches node at any split`, (t) => {
    differential(t, STREAM, corpus, { PROP_ENC: enc }, bytesGen);
  });
}

test('encode/decode round-trip matches node', (t) => {
  // Even length so the utf16le view is well-formed; the CONTENT may still hold
  // lone surrogates, which is the interesting part.
  const evenGen = fc
    .uint8Array({ maxLength: 64 })
    .map((u8) => u8.subarray(0, u8.length - (u8.length % 2)));
  const evenCorpus = fc.sample(evenGen, { seed: SEED, numRuns: RUNS }).map(toHex);
  differential(t, ROUNDTRIP, evenCorpus, {}, evenGen);
});
