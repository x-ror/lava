import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'runtime/gates/assert-case-counts.mjs');
const MANIFEST = join(ROOT, 'runtime/gates/case-counts.json');

test('--all passes against current tree', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /case-count ok/);
});

test('manifest mins are positive integers', () => {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const [key, spec] of Object.entries(m.suites)) {
    assert.ok(Number.isInteger(spec.min) && spec.min > 0, key);
  }
  assert.ok(m.bench.min_files >= 1);
});

test('min floor branch is live (not short-circuited with false &&)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /if \(n < spec\.min\) \{/);
  assert.doesNotMatch(
    src,
    /false\s*&&\s*n\s*<\s*spec\.min/,
    'min floor must not be disabled with false && (agent-cycle mutation pin)',
  );
  assert.match(src, /gate-integrity case-count/);
});
