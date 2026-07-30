// Differential PROPERTY tests: for any input, Lava's answer must equal Node's.
//
// The repo's oracle model is already "same script, both runtimes, byte-identical
// output" — this generates the inputs instead of hand-picking them. That matters
// because every decoder defect found in #320/#321 was an edge case somebody
// either happened to pick or happened to miss: `-0` in an error tail, the 0x2000
// chunk boundary, a lone surrogate, a brace inside a template hole. fast-check
// explores that space and, on a failure, SHRINKS to a minimal reproducer instead
// of handing over the 4 KB buffer that happened to break.
//
// WHY THIS IS NOT AN ORACLE CASE. fast-check stays on the Node side and drives
// `bin/lava` as a subprocess. Requiring it inside Lava would test Lava's module
// resolution against a dual ESM/CJS package rather than the decoder, and would
// put a node_modules dependency on the embedded JS path. So the generator never
// crosses the boundary; only bytes do, via the environment.
//
// Cost: one `node -e` plus one `bin/lava eval` per generated input, ~40ms a pair.
// Kept out of the always-block for that reason — `make test-property` runs it,
// and gates.md routes it for encoding/url/buffer changes.
//
// Run one property while iterating:
//   node --test --test-name-pattern 'utf-8' tests/property/decode.property.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const LAVA = process.env.LAVA_BIN ?? join(ROOT, 'bin', 'lava');
const NODE = process.env.NODE_BIN ?? process.execPath;

// A fixed seed keeps a failure reproducible: the same run explores the same
// space, so "it passed on my machine" is not a possibility. Bump numRuns locally
// to explore further; the committed value is what CI can afford.
const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);
const CONFIG = { seed: 20260730, numRuns: RUNS, verbose: true };

function run(bin, args, script, env) {
  return execFileSync(bin, [...args, script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// Both runtimes evaluate the SAME source and print a JSON-quoted result, so the
// comparison is exact and a mismatch prints readable escapes rather than raw
// bytes.
function differential(script) {
  return (env) => {
    const fromNode = run(NODE, ['-e'], script, env);
    const fromLava = run(LAVA, ['eval'], script, env);
    return { fromNode, fromLava };
  };
}

const DECODE = `
  const bytes = Buffer.from(process.env.PROP_HEX, 'hex');
  const enc = process.env.PROP_ENC;
  const fatal = process.env.PROP_FATAL === '1';
  let out;
  try {
    out = JSON.stringify(new TextDecoder(enc, { fatal: fatal }).decode(bytes));
  } catch (e) {
    out = 'THREW ' + e.name + ' ' + (e.code || '');
  }
  console.log(out);
`;

const compareDecode = differential(DECODE);
const bytes = fc.uint8Array({ maxLength: 96 });
const toHex = (u8) => Buffer.from(u8).toString('hex');

for (const enc of ['utf-8', 'utf-16le', 'windows-1252']) {
  for (const fatal of [false, true]) {
    test(`decode ${enc}${fatal ? ' fatal' : ''} matches node`, () => {
      fc.assert(
        fc.property(bytes, (u8) => {
          const env = { PROP_HEX: toHex(u8), PROP_ENC: enc, PROP_FATAL: fatal ? '1' : '0' };
          const { fromNode, fromLava } = compareDecode(env);
          assert.equal(fromLava, fromNode, `bytes: ${toHex(u8) || '(empty)'}`);
        }),
        CONFIG,
      );
    });
  }
}

// Streaming is where the decoder carries state across calls, and a split in the
// middle of a multi-byte sequence is the shape that broke it before. The split
// point is generated too, so the property covers every boundary rather than the
// three a human would pick.
const STREAM = `
  const bytes = Buffer.from(process.env.PROP_HEX, 'hex');
  const at = Number(process.env.PROP_SPLIT);
  const d = new TextDecoder(process.env.PROP_ENC);
  let out;
  try {
    out = JSON.stringify(
      d.decode(bytes.subarray(0, at), { stream: true }) + d.decode(bytes.subarray(at)),
    );
  } catch (e) {
    out = 'THREW ' + e.name;
  }
  console.log(out);
`;
const compareStream = differential(STREAM);

for (const enc of ['utf-8', 'utf-16le']) {
  test(`streaming ${enc} matches node at any split`, () => {
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 1, maxLength: 64 })
          .chain((u8) => fc.tuple(fc.constant(u8), fc.integer({ min: 0, max: u8.length }))),
        ([u8, at]) => {
          const env = { PROP_HEX: toHex(u8), PROP_ENC: enc, PROP_SPLIT: String(at) };
          const { fromNode, fromLava } = compareStream(env);
          assert.equal(fromLava, fromNode, `bytes: ${toHex(u8)} split at ${at}`);
        },
      ),
      { ...CONFIG, numRuns: Math.max(40, Math.floor(RUNS / 2)) },
    );
  });
}

// Round-trip through the encoder as well: whatever a string encodes to must
// decode back to it, in both runtimes, including lone surrogates (which the
// WHATWG encoder replaces rather than preserving).
const ROUNDTRIP = `
  const s = Buffer.from(process.env.PROP_HEX, 'hex').toString('utf16le');
  const back = new TextDecoder().decode(new TextEncoder().encode(s));
  console.log(JSON.stringify(back));
`;
const compareRoundtrip = differential(ROUNDTRIP);

test('encode/decode round-trip matches node', () => {
  fc.assert(
    fc.property(
      // Even length, so the utf16le view is well-formed; the CONTENT may still
      // contain lone surrogates, which is the interesting part.
      fc.uint8Array({ maxLength: 64 }).map((u8) => u8.subarray(0, u8.length - (u8.length % 2))),
      (u8) => {
        const { fromNode, fromLava } = compareRoundtrip({ PROP_HEX: toHex(u8) });
        assert.equal(fromLava, fromNode, `utf16le bytes: ${toHex(u8) || '(empty)'}`);
      },
    ),
    CONFIG,
  );
});
