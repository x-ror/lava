// Pins agent-system F1.2 benches: --gate must fail when lava is not runnable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUN = join(ROOT, 'bench/run.mjs');

test('bench --gate fails when LAVA_BIN is not runnable', () => {
  const r = spawnSync(process.execPath, [RUN, '--gate'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LAVA_BIN: '/nonexistent/lava-agent-system-probe',
      NODE_BIN: process.execPath,
      BENCH_STARTUP_REPS: '1',
    },
    timeout: 60_000,
  });
  assert.notEqual(
    r.status,
    0,
    `lava not runnable must fail --gate, got ${r.status}\n${r.stdout}\n${r.stderr}`,
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /lava not runnable|benchmark gate FAILED/i);
});

test('run.mjs source still enforces GATE when !haveLava and uncapped list', () => {
  const src = readFileSync(RUN, 'utf8');
  assert.match(src, /benchmark gate FAILED — lava not runnable/);
  assert.match(src, /if \(uncapped\.length > 0\)/);
  assert.doesNotMatch(
    src,
    /false\s*&&\s*uncapped\.length/,
    'uncapped check must not be disabled with false &&',
  );
});

test('thresholds.json has report_only for known uncapped benches', () => {
  const t = JSON.parse(readFileSync(join(ROOT, 'bench/thresholds.json'), 'utf8'));
  assert.ok(Array.isArray(t.report_only));
  assert.ok(t.report_only.includes('decode-win1252'));
  assert.ok(t.report_only.includes('decode-win1252-tiny'));
});
