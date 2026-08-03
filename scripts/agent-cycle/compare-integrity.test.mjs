// Pins scripts/lib/compare.sh gate integrity: lava-vs-lava must exit 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sourceCompare(env) {
  return spawnSync(
    'sh',
    ['-c', `ROOT_DIR="${ROOT}" TMP_DIR=/tmp . "${ROOT}/scripts/lib/compare.sh"`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    },
  );
}

test('compare.sh refuses NODE_BIN=lava under RUN_LAVA=1', () => {
  const r = sourceCompare({
    NODE_BIN: `${ROOT}/bin/lava`,
    LAVA_BIN: `${ROOT}/bin/lava`,
    RUN_LAVA: '1',
  });
  assert.equal(
    r.status,
    2,
    `GATE INTEGRITY must exit 2 for lava-vs-lava, got ${r.status}: ${r.stderr || r.stdout}`,
  );
  assert.match(r.stderr || '', /GATE INTEGRITY/);
});

test('compare.sh allows NODE_BIN=node under RUN_LAVA=1', () => {
  const r = sourceCompare({
    NODE_BIN: 'node',
    LAVA_BIN: `${ROOT}/bin/lava`,
    RUN_LAVA: '1',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('compare.sh is a no-op integrity-wise when RUN_LAVA=0', () => {
  const r = sourceCompare({
    NODE_BIN: `${ROOT}/bin/lava`,
    LAVA_BIN: `${ROOT}/bin/lava`,
    RUN_LAVA: '0',
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
