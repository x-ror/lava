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
//   * the sources it patches must be clean, or it cannot restore them (a git status
//     that FAILS is not clean either — see gitClean)
//   * `source` must stay inside the repo root
//   * `find` must appear exactly once; missing or ambiguous is a FAILURE, not a skip
//   * the gate must be GREEN before mutating, or "it went red" proves nothing
//   * red must be red for the RECORDED reason (expect_detail), or the mutation is
//     not pinning what it names
//   * sources are restored on every exit path — normal, thrown, process.exit, and
//     SIGINT/SIGTERM/SIGHUP — and bin/lava is rebuilt whenever anything could have
//     built it from patched source
// A runner that skipped the green baseline would report success for a gate that was
// already broken, which is the same class of defect it exists to catch. That is not
// hypothetical for this file: every rule above replaced a version that looked right
// and did nothing, and run-mutations.test.mjs pins each one.
//
// GATE KINDS
//   compat:<path>                  oracle case — run under node and bin/lava, diff
//                                  stdout/stderr/exit. RED = any difference.
//   odin:<package>:<test.name>     one Odin test, single runner thread.
//   node-test:<path>               a node:test file.
//   make:<target>                  any Makefile target — for a gate that needs a
//                                  real socket (the *-smoke targets) or a
//                                  multi-step harness. RED = non-zero exit.
//
// `expect_detail` (REQUIRED): a substring the RED output must contain.
// Going red is not enough — a mutation can break something unrelated and look like
// it worked. That happened while seeding this manifest: a mis-escaped `\\d` in a
// replacement produced the regex /^\\d+$/, which matches a literal backslash, so
// EVERY request 400'd and the parity phase failed. The gate reported "killed" and
// the smuggling phase it was supposed to pin never ran.
//
// Usage:
//   node scripts/run-mutations.mjs                 # all
//   node scripts/run-mutations.mjs --filter=clone  # substring match on `name`
//   node scripts/run-mutations.mjs --list

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

// ROOT and MANIFEST are overridable so this runner can be driven against a
// throwaway fixture tree. They were hardcoded, which meant the only way to test
// the gate was to write the real manifest — i.e. the gate that exists to catch
// untested assertions could not itself be tested. See run-mutations.test.mjs.
const ROOT = resolve(
  process.env.MUTATION_ROOT ?? argOf('root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
);
const MANIFEST = resolve(
  process.env.MUTATION_MANIFEST ??
    argOf('manifest') ??
    join(ROOT, 'tests', 'mutation-manifest.json'),
);
const NODE_BIN = process.env.NODE_BIN ?? process.execPath;
const LAVA_BIN = process.env.LAVA_BIN ?? join(ROOT, 'bin', 'lava');
const ODIN = process.env.ODIN ?? 'odin';

const filter = argOf('filter') ?? '';
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

// expect_detail is REQUIRED, not optional. It was optional, which meant an entry
// added without it silently reverted to "any red counts" — the exact behaviour
// 82d8a0e exists to remove. An entry that genuinely cannot name its failure text
// should say so with an explicit empty-string opt-out, so the choice is visible in
// the manifest rather than inferred from an absent key.
const REQUIRED = ['name', 'why', 'source', 'find', 'replace', 'gate', 'expect_detail'];
for (const [i, m] of manifest.mutations.entries()) {
  for (const field of REQUIRED) {
    // expect_detail may be '' (a deliberate, visible opt-out); everything else must
    // be a non-empty string.
    if (typeof m[field] !== 'string' || (m[field] === '' && field !== 'expect_detail')) {
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
  if (kind === 'make') return gateMake(rest.join(':'));
  die(`unknown gate kind "${kind}" in "${gate}"`);
}

// NODE_TEST_CONTEXT is stripped from every child. When node's own test runner
// spawns something, it sets this so a NESTED `node --test` reports up to the parent
// instead of standing alone — and a nested run with a FAILING test then exits 0.
// Measured: `node --test <failing>` exits 1, and `NODE_TEST_CONTEXT=child-v8 node
// --test <failing>` exits 0. Inherited, that makes every `node-test:` gate report
// green no matter what, so the baseline passes and every mutation reads SURVIVED.
// This runner is spawned from a node:test file by its own tests, and `make
// test-mutation` can be invoked from any harness that sets it, so the fix belongs
// here rather than in the caller.
function capture(bin, argv, opts = {}) {
  const env = { ...(opts.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(bin, argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env,
  });
  if (r.error) return { status: -1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gateCompat(relPath) {
  const file = join(ROOT, relPath);
  const n = capture(NODE_BIN, [file]);
  const l = capture(LAVA_BIN, ['run', file]);
  // Accumulate every difference rather than returning on the first. Returning
  // early on an exit-status mismatch discarded the stdout/stderr diff, which left
  // a case that fails via an assertion MESSAGE with no reachable detail at all —
  // so its entry could only record `expect_detail: "exit"`, which is implied by
  // RED itself and therefore asserts nothing.
  const parts = [];
  if (n.status !== l.status) parts.push(`exit: node=${n.status} lava=${l.status}`);
  if (n.stdout !== l.stdout) parts.push(firstDiff(n.stdout, l.stdout));
  if (n.stderr !== l.stderr) parts.push(firstDiff(n.stderr, l.stderr));
  if (parts.length === 0) return { ok: true, detail: 'node and lava agree' };
  return { ok: false, detail: parts.join('\n') };
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

// `make` gates own their own build, so the runner must not also rebuild for them —
// `rebuild: false` is correct even for an embedded-JS mutation here, because the
// target's own `build` prerequisite picks the patched source up.
function gateMake(target) {
  const r = capture('make', [target], { cwd: ROOT });
  if (r.status === 0) return { ok: true, detail: `make ${target} passed` };
  const text = r.stdout + r.stderr;
  // Prefer the line naming WHICH phase failed over the first generic error, so
  // expect_detail can distinguish "the phase I meant" from "something else broke".
  const lines = text.split('\n');
  const labelled = lines.find((l) => /FAILED: .* checks failed/.test(l));
  const fail = labelled ?? lines.find((l) => /^FAIL |FAILED|Error \d/.test(l));
  return { ok: false, detail: fail ? fail.trim() : `make ${target} exited ${r.status}` };
}

function gateNodeTest(relPath) {
  const r = capture(NODE_BIN, ['--test', join(ROOT, relPath)]);
  const text = r.stdout + r.stderr;
  if (r.status === 0) return { ok: true, detail: 'node:test passed' };
  // BOTH the failing test name and the assertion message. Returning only the `✖`
  // line gave the test's NAME and threw the reason away, so `expect_detail` could
  // never name why a gate went red — only which test did. An assertion message is
  // the one string an author controls and the natural thing to record.
  const lines = text.split('\n');
  const names = lines.filter((l) => /^\s*✖ /.test(l) && !/failing tests:/.test(l));
  const reasons = lines.filter((l) => /Error(\s\[[A-Z_]+\])?:/.test(l));
  const detail = [...new Set([...names, ...reasons])].map((l) => l.trim()).join(' | ');
  return { ok: false, detail: detail || `node --test exited ${r.status}` };
}

// --- patching ---------------------------------------------------------------

// A non-zero git status is NOT "clean". It returned only stdout, and
// `git status --porcelain -- ../outside` exits 128 with EMPTY stdout — so a path
// that escaped the repo read as clean and the runner then rewrote a file outside
// it. Paired with the containment check in applyMutation.
function gitClean(relPaths) {
  const r = capture('git', ['status', '--porcelain', '--', ...relPaths], { cwd: ROOT });
  if (r.status !== 0) {
    die(`git status failed for [${relPaths.join(', ')}] (exit ${r.status}): ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

const originals = new Map(); // absolute path -> original text

function restoreAll() {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
}

// `process.on('exit')`, not a signal handler. This program's body is entirely
// SYNCHRONOUS (spawnSync throughout), so a registered SIGINT listener never gets
// a turn to run — while its mere presence removes node's default terminate-on-
// SIGINT. The net effect of the previous version was that Ctrl-C did nothing at
// all, and escalating to SIGTERM skipped the restore, leaving a source patched
// with deliberately-reintroduced vulnerable code in the working tree.
//
// An 'exit' listener runs on every normal and thrown path including
// process.exit(), and is synchronous, which is exactly what restoring files
// needs. The signals are then re-raised with the default disposition so the
// caller still sees a real signal death.
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\nmutation gate: ${sig} — restoring sources`);
    restoreAll();
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  });
}

function applyMutation(m) {
  // Containment: `join(ROOT, '../../.bashrc')` resolves happily outside the repo,
  // and this function reads and REWRITES whatever it is handed before make spawns
  // shells over the result.
  const file = resolve(ROOT, m.source);
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    throw new Error(`"source" escapes the repo root: ${m.source} -> ${file}`);
  }
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
  // A literal splice, NOT String.replace: with a string pattern, `$&`, `$\``,
  // `$'` and `$n` in the REPLACEMENT are substitution patterns, so a replacement
  // containing them would silently write text the manifest does not record —
  // and "it went red" would then be reported about a patch nobody wrote.
  const at = text.indexOf(m.find);
  writeFileSync(file, text.slice(0, at) + m.replace + text.slice(at + m.find.length));
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
// Two different questions, previously conflated into one flag:
//   needsBuild    — must bin/lava be built BEFORE the gate runs? Only `compat:`
//                   needs that; `odin:` compiles its own package, `node-test:`
//                   never touches the binary, and a `make:` target carries its own
//                   `build` prerequisite.
//   dirtiesBinary — did anything we ran leave bin/lava built from patched source?
//                   A `make:` gate DOES, precisely because of that prerequisite —
//                   so `--filter` over only `make:` entries used to finish with a
//                   clean git tree, a success message, and a bin/lava on disk that
//                   validated Content-Length with the reverted, poisonable check.
const needsBuild = selected.some((m) => m.rebuild || m.gate.startsWith('compat:'));
const dirtiesBinary = selected.some(
  (m) => m.rebuild || m.gate.startsWith('compat:') || m.gate.startsWith('make:'),
);

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
      if (m.rebuild || m.gate.startsWith('compat:')) build();
      const r = runGate(m.gate);
      if (r.ok) {
        failures++;
        console.log('SURVIVED');
        console.log(`           the gate still passes with this code broken.`);
        console.log(`           expected to catch: ${m.why}`);
        console.log(`           gate: ${m.gate}`);
      } else if (m.expect_detail && !r.detail.includes(m.expect_detail)) {
        // Red, but not for the recorded reason — so this mutation is not pinning
        // what it claims to. Treated as a failure, because a mutation that breaks
        // something unrelated proves nothing about the test it names.
        failures++;
        console.log('WRONG REASON');
        console.log(`           expected the failure to mention: ${m.expect_detail}`);
        console.log(`           got: ${r.detail.split('\n')[0]}`);
      } else {
        console.log(`killed (${r.detail.split('\n')[0]})`);
      }
    } finally {
      restoreAll();
    }
  }

  // Unconditional when anything could have rebuilt from patched source. Leaving a
  // vulnerable binary behind is worse than an extra 25s build, and it is silent.
  if (dirtiesBinary) {
    process.stdout.write('\n  restore build ... ');
    build();
    console.log('ok');
  }
} finally {
  restoreAll();
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
