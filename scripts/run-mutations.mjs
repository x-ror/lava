#!/usr/bin/env node
// Mutation gate: prove each recorded test actually dies when the code it claims to
// pin is broken.
//
// CLAUDE.md section 6 already required this by hand ("A test is not done until a
// mutation has failed it"). Doing it by hand depends on remembering to, and three
// tests in #321 got past exactly that: an oracle case that threw inside its own
// setup and so printed identical output on both runtimes, a property suite that
// compared zero inputs after a NaN run count, and an event-loop test whose timer
// handed platform_poll a positive timeout — which counts as progress by itself, so
// the no-progress tick under test never happened. All three passed. All three
// passed just as well with the code they pinned deleted.
//
// The runner is only worth as much as its own honesty, so it refuses to report on
// anything it cannot establish:
//   * the working tree must be clean for the files it patches, or it cannot restore
//   * `find` must appear EXACTLY once, or the patch is ambiguous
//   * the gate must be GREEN before mutating, or "it went red" proves nothing
//   * the tree is restored on any exit path, including SIGINT
// A runner that skipped the green baseline would report success for a gate that was
// already broken, which is the same class of defect it exists to catch.
//
// GATE KINDS
//   compat:<path>                  oracle case — run under node and bin/lava, diff
//                                  stdout/stderr/exit. RED = any difference.
//   odin:<package>:<test.name>     one Odin test, single runner thread.
//   node-test:<path>               a node:test file.
//
// Usage:
//   node scripts/run-mutations.mjs                 # all
//   node scripts/run-mutations.mjs --filter=clone  # substring match on `name`
//   node scripts/run-mutations.mjs --list

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'tests', 'mutation-manifest.json');
const NODE_BIN = process.env.NODE_BIN ?? process.execPath;
const LAVA_BIN = process.env.LAVA_BIN ?? join(ROOT, 'bin', 'lava');
const ODIN = process.env.ODIN ?? 'odin';

const args = process.argv.slice(2);
const filter = (args.find((a) => a.startsWith('--filter=')) ?? '').slice('--filter='.length);
const listOnly = args.includes('--list');

function die(msg) {
  console.error(`mutation gate: ${msg}`);
  process.exit(1);
}

// --- manifest ---------------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (err) {
  die(`${MANIFEST} is not valid JSON: ${err.message}`);
}
if (!Array.isArray(manifest.mutations) || manifest.mutations.length === 0) {
  die(`${MANIFEST} has no mutations — an empty manifest must not read as a pass`);
}

const REQUIRED = ['name', 'why', 'source', 'find', 'replace', 'gate'];
for (const [i, m] of manifest.mutations.entries()) {
  for (const field of REQUIRED) {
    if (typeof m[field] !== 'string' || m[field] === '') {
      die(`mutation #${i} is missing "${field}"`);
    }
  }
  if (m.find === m.replace) die(`mutation "${m.name}" does not change anything`);
}

const selected = filter
  ? manifest.mutations.filter((m) => m.name.includes(filter))
  : manifest.mutations;
if (selected.length === 0) die(`no mutation matches --filter=${filter}`);

if (listOnly) {
  for (const m of selected) console.log(`${m.gate}\n  ${m.name}\n  ${m.why}\n`);
  process.exit(0);
}

// --- gates ------------------------------------------------------------------

// Every gate returns {ok, detail}. `ok: false` is RED, which under mutation is
// what we want and on the baseline is a hard stop.
function runGate(gate) {
  const [kind, ...rest] = gate.split(':');
  if (kind === 'compat') return gateCompat(rest.join(':'));
  if (kind === 'odin') return gateOdin(rest[0], rest[1]);
  if (kind === 'node-test') return gateNodeTest(rest.join(':'));
  die(`unknown gate kind "${kind}" in "${gate}"`);
}

function capture(bin, argv, opts = {}) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) return { status: -1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gateCompat(relPath) {
  const file = join(ROOT, relPath);
  const n = capture(NODE_BIN, [file]);
  const l = capture(LAVA_BIN, ['run', file]);
  if (n.status !== l.status) {
    return { ok: false, detail: `exit: node=${n.status} lava=${l.status}` };
  }
  if (n.stdout !== l.stdout) return { ok: false, detail: firstDiff(n.stdout, l.stdout) };
  if (n.stderr !== l.stderr) return { ok: false, detail: firstDiff(n.stderr, l.stderr) };
  return { ok: true, detail: 'node and lava agree' };
}

function firstDiff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      return `line ${i + 1}:\n    node: ${trunc(al[i])}\n    lava: ${trunc(bl[i])}`;
    }
  }
  return 'outputs differ';
}
const trunc = (s) => (s === undefined ? '(absent)' : s.length > 140 ? s.slice(0, 137) + '...' : s);

function gateOdin(pkg, testName) {
  const out = join(ROOT, 'bin', '.mutation-odin.bin');
  const r = capture(ODIN, [
    'test',
    join(ROOT, pkg),
    `-collection:lava=${ROOT}`,
    '-define:ODIN_TEST_THREADS=1',
    `-define:ODIN_TEST_NAMES=${testName}`,
    `-out:${out}`,
  ]);
  const text = r.stdout + r.stderr;
  // The Odin runner exits 0 on a build failure in some versions, so read the
  // summary line rather than trusting the status alone.
  if (/\bAll tests were successful\.|The test was successful\./.test(text)) {
    return { ok: true, detail: 'odin test passed' };
  }
  const err = text.split('\n').find((l) => l.includes('[ERROR]') || l.includes('Error:'));
  return { ok: false, detail: err ? err.trim() : `odin test exited ${r.status}` };
}

function gateNodeTest(relPath) {
  const r = capture(NODE_BIN, ['--test', join(ROOT, relPath)]);
  const text = r.stdout + r.stderr;
  if (r.status === 0) return { ok: true, detail: 'node:test passed' };
  const fail = text.split('\n').find((l) => /^\s*✖/.test(l) || l.includes('AssertionError'));
  return { ok: false, detail: fail ? fail.trim() : `node --test exited ${r.status}` };
}

// --- patching ---------------------------------------------------------------

function gitClean(relPaths) {
  const r = capture('git', ['status', '--porcelain', '--', ...relPaths], { cwd: ROOT });
  return r.stdout.trim();
}

const originals = new Map(); // absolute path -> original text
let currentlyPatched = null;

function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
  currentlyPatched = null;
}

process.on('SIGINT', () => {
  console.error('\nmutation gate: interrupted — restoring sources');
  restoreAll();
  process.exit(130);
});

function applyMutation(m) {
  const file = join(ROOT, m.source);
  const text = readFileSync(file, 'utf8');
  const hits = text.split(m.find).length - 1;
  if (hits === 0) {
    throw new Error(
      `"find" does not appear in ${m.source} — the code moved, so this mutation no longer describes it`,
    );
  }
  if (hits > 1) {
    throw new Error(`"find" appears ${hits}x in ${m.source} — ambiguous, make it unique`);
  }
  if (!originals.has(file)) originals.set(file, text);
  writeFileSync(file, text.replace(m.find, m.replace));
  currentlyPatched = m.source;
}

function revertMutation(m) {
  const file = join(ROOT, m.source);
  const text = originals.get(file);
  if (text !== undefined) writeFileSync(file, text);
  currentlyPatched = null;
}

function build() {
  const r = capture('make', ['build'], { cwd: ROOT });
  if (r.status !== 0) throw new Error(`make build failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
}

// --- run --------------------------------------------------------------------

const touched = [...new Set(selected.map((m) => m.source))];
const dirty = gitClean(touched);
if (dirty) {
  die(
    `these sources have uncommitted changes, so they cannot be safely restored:\n${dirty}\n` +
      `commit or stash them first`,
  );
}

console.log(`mutation gate: ${selected.length} mutation(s)\n`);

let failures = 0;
let checked = 0;
const needsBuild = selected.some((m) => m.rebuild);

try {
  if (needsBuild) {
    process.stdout.write('  baseline build ... ');
    build();
    console.log('ok');
  }

  // Baseline: every gate must be GREEN before anything is mutated. A gate that is
  // already red would "go red" under mutation for free.
  const gates = [...new Set(selected.map((m) => m.gate))];
  for (const gate of gates) {
    process.stdout.write(`  baseline ${gate} ... `);
    const r = runGate(gate);
    if (!r.ok) {
      console.log('RED');
      die(`gate "${gate}" is already failing before any mutation:\n    ${r.detail}`);
    }
    console.log('green');
  }
  console.log('');

  for (const m of selected) {
    checked++;
    process.stdout.write(`  [${checked}/${selected.length}] ${m.name}\n           ... `);
    try {
      applyMutation(m);
    } catch (err) {
      // A manifest entry that no longer describes the code is a FAILURE, not a
      // skip: silently passing over it would quietly drop the coverage this gate
      // exists to guarantee, which is the same shape as the defects it catches.
      failures++;
      console.log('STALE');
      console.log(`           ${err.message}`);
      continue;
    }
    try {
      if (m.rebuild) build();
      const r = runGate(m.gate);
      if (r.ok) {
        failures++;
        console.log('SURVIVED');
        console.log(`           the gate still passes with this code broken.`);
        console.log(`           expected to catch: ${m.why}`);
        console.log(`           gate: ${m.gate}`);
      } else {
        console.log(`killed (${r.detail.split('\n')[0]})`);
      }
    } finally {
      revertMutation(m);
    }
  }

  if (needsBuild) {
    process.stdout.write('\n  restore build ... ');
    build();
    console.log('ok');
  }
} finally {
  restoreAll();
  if (currentlyPatched) console.error(`WARNING: ${currentlyPatched} may still be patched`);
}

console.log('');
if (failures > 0) {
  console.error(
    `mutation gate FAILED: ${failures}/${checked} mutation(s) did not do their job —\n` +
      `either the test survived the break (it is asserting something else), or the\n` +
      `manifest entry no longer matches the code it describes.`,
  );
  process.exit(1);
}
console.log(`mutation gate ok: ${checked}/${checked} test(s) died as recorded.`);
