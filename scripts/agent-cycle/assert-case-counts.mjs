#!/usr/bin/env node
// Agent-cycle F1.2 — assert oracle/bench file counts against case-counts.json.
// Sourced by runners via: node scripts/agent-cycle/assert-case-counts.mjs <suite-key>
// Or: node scripts/agent-cycle/assert-case-counts.mjs --all

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = join(ROOT, 'scripts/agent-cycle/case-counts.json');

function countMatches(dir, globs) {
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  let n = 0;
  for (const name of names) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    for (const g of globs) {
      // only *.ext style
      if (g.startsWith('*.') && name.endsWith(g.slice(1))) {
        n++;
        break;
      }
    }
  }
  return n;
}

function assertSuite(key, spec) {
  const dir = join(ROOT, key);
  const n = countMatches(dir, spec.globs || ['*.js']);
  if (n < spec.min) {
    console.error(
      `gate-integrity case-count: ${key} has ${n} cases, expected >= ${spec.min} (see scripts/agent-cycle/case-counts.json)`,
    );
    process.exit(1);
  }
  console.log(`case-count ok: ${key} ${n} >= ${spec.min}`);
}

function assertBench(spec) {
  let n = 0;
  for (const d of spec.dirs || []) {
    const dir = join(ROOT, d);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if ((spec.exclude || []).includes(name)) continue;
      if (name.endsWith('.js')) n++;
    }
  }
  if (n < spec.min_files) {
    console.error(
      `gate-integrity bench-count: found ${n} bench files, expected >= ${spec.min_files}`,
    );
    process.exit(1);
  }
  console.log(`bench-count ok: ${n} >= ${spec.min_files}`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const arg = process.argv[2] || '--all';

if (arg === '--all') {
  for (const [key, spec] of Object.entries(manifest.suites || {})) assertSuite(key, spec);
  if (manifest.bench) assertBench(manifest.bench);
  process.exit(0);
}

if (arg === 'bench') {
  assertBench(manifest.bench);
  process.exit(0);
}

const spec = manifest.suites?.[arg];
if (!spec) {
  console.error(`unknown suite key: ${arg}`);
  process.exit(2);
}
assertSuite(arg, spec);
