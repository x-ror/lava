// Benchmark orchestrator: run every bench/{micro,macro}/*.js under both Node (the oracle)
// and Lava, plus an external process-startup measurement, then print a node-vs-lava table
// and — with --gate — fail on any benchmark whose lava/node ratio exceeds its cap in
// bench/thresholds.json. All timing/parsing lives here (in Node, always present) rather
// than in shell, so the runner is portable across Linux/macOS and easy to extend.
//
// Env: NODE_BIN (oracle, default "node"), LAVA_BIN (default ../bin/lava), BENCH_STARTUP_REPS.
// Usage: node bench/run.mjs [--gate]

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NODE_BIN = process.env.NODE_BIN || 'node';
const LAVA_BIN = process.env.LAVA_BIN || join(ROOT, 'bin', 'lava');
const STARTUP_REPS = Number(process.env.BENCH_STARTUP_REPS || 15);
const GATE = process.argv.includes('--gate');
const MARKER = '##BENCH##';

// Collect the bench files (micro then macro), excluding the startup noop target and lib.
function benchFiles() {
  const out = [];
  for (const group of ['micro', 'macro']) {
    const dir = join(ROOT, 'bench', group);
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.js') && name !== 'noop.js') out.push(join(dir, name));
    }
  }
  return out;
}

// Run one bench file under a runtime and return the parsed ##BENCH## result lines.
function runFile(bin, args, file) {
  let stdout;
  try {
    stdout = execFileSync(bin, [...args, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (e) {
    throw new Error(`${bin} failed on ${file}: ${e.message}`);
  }
  const results = [];
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(MARKER);
    if (at < 0) continue;
    results.push(JSON.parse(line.slice(at + MARKER.length)));
  }
  return results;
}

// Time a process from spawn to exit, best of STARTUP_REPS, for the startup metric.
function measureStartup(bin, args) {
  let best = Infinity;
  for (let i = 0; i < STARTUP_REPS; i++) {
    const t0 = performance.now();
    execFileSync(bin, args, { stdio: 'ignore' });
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return Number(best.toFixed(4));
}

function collect(bin, args) {
  const byName = new Map();
  for (const file of benchFiles()) {
    for (const r of runFile(bin, args, file)) byName.set(r.name, r);
  }
  return byName;
}

const haveLava = (() => {
  try {
    execFileSync(LAVA_BIN, ['eval', '0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

console.log(`node: ${NODE_BIN}`);
console.log(
  `lava: ${LAVA_BIN}${haveLava ? '' : '  (not runnable — node-only report)'}`,
);

const noop = join(ROOT, 'bench', 'micro', 'noop.js');
const nodeResults = collect(NODE_BIN, []);
nodeResults.set('startup', {
  name: 'startup',
  iterations: STARTUP_REPS,
  ms: measureStartup(NODE_BIN, [noop]),
});

let lavaResults = new Map();
if (haveLava) {
  lavaResults = collect(LAVA_BIN, ['run']);
  lavaResults.set('startup', {
    name: 'startup',
    iterations: STARTUP_REPS,
    ms: measureStartup(LAVA_BIN, ['run', noop]),
  });
}

const names = [...nodeResults.keys()];
const thresholds =
  JSON.parse(readFileSync(join(ROOT, 'bench', 'thresholds.json'), 'utf8'))
    .caps || {};

// Table.
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log('');
console.log(
  `${pad('benchmark', 26)} ${padL('node ms', 12)} ${padL('lava ms', 12)} ${padL('ratio', 8)} ${padL('cap', 6)}`,
);
console.log('-'.repeat(68));

const breaches = [];
for (const name of names) {
  const n = nodeResults.get(name);
  const l = lavaResults.get(name);
  const cap = thresholds[name];
  let ratioStr = '-';
  const capStr = cap != null ? `${cap}x` : '-';
  if (haveLava && l) {
    const ratio = n.ms > 0 ? l.ms / n.ms : 0;
    ratioStr = `${ratio.toFixed(2)}x`;
    if (GATE && cap != null && ratio > cap) breaches.push({ name, ratio, cap });
  }
  console.log(
    `${pad(name, 26)} ${padL(n.ms.toFixed(3), 12)} ${padL(l ? l.ms.toFixed(3) : '-', 12)} ${padL(ratioStr, 8)} ${padL(capStr, 6)}`,
  );
}
console.log('');

if (!haveLava) {
  console.log(
    'lava not runnable: printed Node baseline only (no ratios, no gate).',
  );
  process.exit(0);
}

if (GATE) {
  if (breaches.length > 0) {
    console.error('benchmark gate FAILED — lava/node ratio exceeded cap:');
    for (const b of breaches)
      console.error(`  ${b.name}: ${b.ratio.toFixed(2)}x > ${b.cap}x cap`);
    process.exit(1);
  }
  console.log('benchmark gate passed (all ratios within caps).');
} else {
  console.log(
    'report-only (no gate). Run with --gate to enforce bench/thresholds.json caps.',
  );
}
