// The mutation gate's own tests.
//
// `/pr-gate` graded the absence of this file P0, and the reason is worth keeping:
// invert `if (r.ok)`, delete the baseline loop, or turn STALE into a silent
// `continue`, and every gate in the repo stayed green. A gate whose entire value is
// its own honesty had nothing checking that honesty — the same defect class it
// exists to catch, in itself.
//
// Each case drives the real runner as a subprocess against a THROWAWAY tree
// (`--root=` / `--manifest=`), never the repo. The fixture "gate" is a node:test
// file inside that tree whose pass/fail is decided by the fixture source, so a case
// can make the gate green, red-for-the-right-reason, or red-for-the-wrong-reason on
// demand without building anything.
//
// Every case also asserts the fixture source is byte-identical afterwards. That is
// not belt-and-braces: the manifest's replacements are, by construction, the
// pre-fix vulnerable code, so a restore that silently fails leaves a reintroduced
// security bug in a working tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'run-mutations.mjs');

// The fixture source. `VALUE` is what the gate asserts on; a mutation that changes
// it makes the gate red, and one that only touches the comment leaves it green.
const SOURCE = `// fixture module — MARKER
export const VALUE = 'expected';
export const OTHER = 'untouched';
`;

// The fixture gate. Distinct assertion messages so expect_detail can tell the two
// failure modes apart, which is the whole point of the field.
const GATE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { VALUE, OTHER } from './src.mjs';
test('value is expected', () => {
  assert.equal(VALUE, 'expected', 'THE-RECORDED-REASON');
});
test('other is untouched', () => {
  assert.equal(OTHER, 'untouched', 'AN-UNRELATED-REASON');
});
`;

function makeTree(mutations, { source = SOURCE, gate = GATE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lava-mut-'));
  mkdirSync(join(dir, 'fx'), { recursive: true });
  writeFileSync(join(dir, 'fx', 'src.mjs'), source);
  writeFileSync(join(dir, 'fx', 'gate.test.mjs'), gate);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ mutations }, null, 2));
  // A real git repo: the runner refuses to touch sources it cannot restore, and
  // that refusal is itself one of the behaviours under test.
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function run(dir, extra = []) {
  const r = spawnSync(
    process.execPath,
    [RUNNER, `--root=${dir}`, `--manifest=${join(dir, 'manifest.json')}`, ...extra],
    { encoding: 'utf8', cwd: dir },
  );
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const entry = (over = {}) => ({
  name: 'fixture dies when VALUE is broken',
  why: 'the gate must observe VALUE',
  source: 'fx/src.mjs',
  find: "export const VALUE = 'expected';",
  replace: "export const VALUE = 'BROKEN';",
  gate: 'node-test:fx/gate.test.mjs',
  expect_detail: 'THE-RECORDED-REASON',
  ...over,
});

const sourceOf = (dir) => readFileSync(join(dir, 'fx', 'src.mjs'), 'utf8');

function withTree(mutations, opts, fn) {
  const dir = makeTree(mutations, opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a mutation that kills its gate for the recorded reason passes', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.match(out, /1\/1 test\(s\) died as recorded/);
    assert.equal(status, 0);
    assert.equal(sourceOf(dir), SOURCE, 'source must be restored');
  });
});

test('a mutation the gate does not notice is reported SURVIVED, exit 1', () => {
  // The headline case: mutate only the comment, so the gate stays green. If the
  // runner reports this as killed it is not observing the gate at all.
  withTree(
    [
      entry({
        find: '// fixture module — MARKER',
        replace: '// fixture module — MUTATED COMMENT',
        why: 'a comment-only change cannot affect the gate',
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.match(out, /SURVIVED/);
      assert.doesNotMatch(out, /died as recorded/);
      assert.equal(status, 1);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('red for an UNRECORDED reason is WRONG REASON, not a kill', () => {
  // This is 82d8a0e's entire point. The mutation breaks OTHER, so the gate goes
  // red — but on the assertion the entry does not name. Reporting that as "killed"
  // is how a mis-escaped replacement once looked like it worked.
  withTree(
    [
      entry({
        find: "export const OTHER = 'untouched';",
        replace: "export const OTHER = 'BROKEN';",
        expect_detail: 'THE-RECORDED-REASON',
      }),
    ],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.match(out, /WRONG REASON/);
      assert.match(out, /AN-UNRELATED-REASON/, 'must show what it got instead');
      assert.doesNotMatch(out, /died as recorded/);
      assert.equal(status, 1);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('a find that no longer matches is STALE and fails — never a skip', () => {
  withTree([entry({ find: 'THIS TEXT DOES NOT EXIST' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /STALE/);
    assert.match(out, /does not appear/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

test('an ambiguous find fails rather than patching an arbitrary occurrence', () => {
  // The source must still satisfy the gate, or the run stops at the red baseline
  // and never reaches the ambiguity check — which is what the runner did on the
  // first version of this fixture, correctly.
  const dup =
    "// fixture module — MARKER\nexport const VALUE = 'expected';\nexport const OTHER = 'untouched';\nconst PAD = 'expected';\nexport const USED = PAD;\n";
  withTree([entry({ find: "'expected'", replace: "'y'" })], { source: dup }, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /ambiguous/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), dup);
  });
});

test('a gate that is already red is refused, and nothing is patched', () => {
  // "It went red" proves nothing about a gate that was already failing.
  const brokenSrc = SOURCE.replace("'expected'", "'ALREADY-BROKEN'");
  withTree([entry()], { source: brokenSrc }, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /already failing before any mutation/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), brokenSrc, 'must not patch after refusing');
  });
});

test('a dirty source is refused, since it could not be restored', () => {
  withTree([entry()], {}, (dir) => {
    writeFileSync(join(dir, 'fx', 'src.mjs'), SOURCE + '// uncommitted\n');
    const { status, out } = run(dir);
    assert.match(out, /uncommitted changes/);
    assert.equal(status, 1);
  });
});

test('a source escaping the repo root is refused', () => {
  // join(ROOT, '../../x') resolves happily outside the tree, and this runner
  // rewrites what it is handed before make spawns shells over the result.
  withTree([entry({ source: '../escape.mjs' })], {}, (dir) => {
    writeFileSync(join(dir, '..', 'escape.mjs'), 'outside\n');
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /escapes the repo root|git status failed/);
    assert.equal(readFileSync(join(dir, '..', 'escape.mjs'), 'utf8'), 'outside\n');
    rmSync(join(dir, '..', 'escape.mjs'), { force: true });
  });
});

test('a replacement containing $-substitution patterns is written literally', () => {
  // With String.replace and a string pattern, `$&` and `$'` expand. A manifest
  // entry would then apply a patch nobody wrote, and "went red" would be reported
  // about it.
  const repl = 'export const VALUE = "$& and $\' and $1";';
  withTree([entry({ replace: repl, expect_detail: 'THE-RECORDED-REASON' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.equal(status, 0);
    assert.equal(sourceOf(dir), SOURCE);
    assert.doesNotMatch(out, /\$& and/, 'the runner should not echo an expanded patch');
  });
});

test('an empty manifest fails rather than reading as a pass', () => {
  withTree([], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /no mutations/);
    assert.equal(status, 1);
  });
});

test('a --filter matching nothing fails rather than reporting 0/0 ok', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir, ['--filter=nothing-matches-this']);
    assert.match(out, /no mutation matches/);
    assert.equal(status, 1);
  });
});

test('expect_detail is required, so an entry cannot silently opt out of it', () => {
  const e = entry();
  delete e.expect_detail;
  withTree([e], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /missing "expect_detail"/);
    assert.equal(status, 1);
  });
});

test('an explicit empty expect_detail is allowed — the opt-out must be visible', () => {
  withTree([entry({ expect_detail: '' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /killed/);
    assert.equal(status, 0);
  });
});

test('--list reports without patching anything', () => {
  withTree([entry()], {}, (dir) => {
    const { status, out } = run(dir, ['--list']);
    assert.equal(status, 0);
    assert.match(out, /fixture dies when VALUE is broken/);
    assert.equal(sourceOf(dir), SOURCE);
  });
});

test('every mutation runs — one failure does not abort the rest', () => {
  withTree([entry({ name: 'first' }), entry({ name: 'second', find: 'NOPE' })], {}, (dir) => {
    const { status, out } = run(dir);
    assert.match(out, /\[1\/2\]/);
    assert.match(out, /\[2\/2\]/);
    assert.match(out, /STALE/);
    assert.equal(status, 1);
    assert.equal(sourceOf(dir), SOURCE);
  });
});
