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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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

function run(dir, extra = [], env = {}) {
  const r = spawnSync(
    process.execPath,
    [RUNNER, `--root=${dir}`, `--manifest=${join(dir, 'manifest.json')}`, ...extra],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, ...env } },
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

// The next two cases were ONE case with a disjunction —
// `/escapes the repo root|git status failed/` — and a review proved that pinned
// neither guard: deleting the containment check alone left 16/16 green, and so did
// deleting the git-status check alone. Only removing both went red. They are split
// so each asserts its own message, with no alternation.
test('a source escaping the repo root is refused by the containment check', () => {
  // The escape target lives INSIDE the fixture's own tree, in a committed
  // subdirectory, so `git status` succeeds and cannot be what fails. That isolates
  // the containment check as the only thing that can reject this.
  withTree([entry({ source: 'sub/../../escape.mjs' })], {}, (dir) => {
    const outside = join(dir, '..', `escape-${process.pid}.mjs`);
    writeFileSync(outside, 'outside\n');
    try {
      const { status, out } = run(dir);
      assert.equal(status, 1);
      assert.match(out, /escapes the repo root/);
      assert.doesNotMatch(out, /git status failed/, 'must fail on containment, not on git');
      assert.equal(readFileSync(outside, 'utf8'), 'outside\n');
    } finally {
      // In the finally, not after the assertions: a failing assertion used to leak
      // this file into the shared tmpdir, where two concurrent runs then raced on
      // a fixed name.
      rmSync(outside, { force: true });
    }
  });
});

test('a git status that FAILS is not read as clean', () => {
  // `git status --porcelain -- <path>` exits 128 with EMPTY stdout when the path is
  // outside the repo, so returning only stdout made a failure read as clean. Here
  // the tree is not a git repo at all, which makes git exit non-zero for a source
  // that is perfectly well contained.
  const dir = mkdtempSync(join(tmpdir(), 'lava-mut-nogit-'));
  try {
    mkdirSync(join(dir, 'fx'), { recursive: true });
    writeFileSync(join(dir, 'fx', 'src.mjs'), SOURCE);
    writeFileSync(join(dir, 'fx', 'gate.test.mjs'), GATE);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ mutations: [entry()] }, null, 2));
    const { status, out } = run(dir);
    assert.equal(status, 1);
    assert.match(out, /git status failed/);
    assert.doesNotMatch(out, /escapes the repo root/, 'must fail on git, not on containment');
    assert.equal(readFileSync(join(dir, 'fx', 'src.mjs'), 'utf8'), SOURCE, 'nothing patched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink pointing out of the repo is refused, not followed', () => {
  // The containment check is LEXICAL unless it resolves: `resolve()` does not follow
  // symlinks and `readFileSync`/`writeFileSync` do, so an in-repo link to an
  // out-of-root file passed the prefix test and the runner rewrote the target.
  // Reproduced by a review before realpathSync was added.
  withTree([entry({ source: 'fx/link.mjs' })], {}, (dir) => {
    const outside = join(dir, '..', `victim-${process.pid}.mjs`);
    writeFileSync(outside, 'DO-NOT-TOUCH\n');
    try {
      symlinkSync(outside, join(dir, 'fx', 'link.mjs'));
      const { status, out } = run(dir);
      assert.equal(status, 1);
      assert.match(out, /escapes the repo root/);
      assert.equal(readFileSync(outside, 'utf8'), 'DO-NOT-TOUCH\n', 'target must be untouched');
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

test('a make: gate leaves the binary rebuilt from RESTORED source', () => {
  // needsBuild/dirtiesBinary had no coverage at all: every other fixture uses a
  // `node-test:` gate, so neither the compat-implies-build rule nor the
  // make-dirties-the-binary rule ever executed under test. The bug that split fixed
  // was security-relevant — a `--filter` over make: entries finished with a clean
  // git tree, a success message, and a bin/lava built from the mutated source.
  const dir = makeTree([
    {
      name: 'fixture dies when VALUE is broken',
      why: 'the make gate must observe VALUE through the built artifact',
      source: 'fx/src.mjs',
      find: "export const VALUE = 'expected';",
      replace: "export const VALUE = 'BROKEN';",
      gate: 'make:gate',
      expect_detail: 'make gate saw BROKEN',
    },
  ]);
  try {
    // `build` copies the source to the artifact; `gate` fails when the artifact
    // carries the mutation. Tabs matter to make.
    writeFileSync(
      join(dir, 'Makefile'),
      'build:\n\tmkdir -p bin && cp fx/src.mjs bin/lava\n\n' +
        'gate: build\n\t@grep -q BROKEN bin/lava && { echo "make gate saw BROKEN"; exit 1; } || exit 0\n',
    );
    const { status, out } = run(dir);
    assert.equal(status, 0, out);
    assert.match(out, /killed/);
    // The point of the case: the artifact on disk must be the RESTORED source, not
    // the mutated one the gate just built from.
    assert.equal(readFileSync(join(dir, 'bin', 'lava'), 'utf8'), SOURCE, 'binary must be rebuilt');
    assert.equal(sourceOf(dir), SOURCE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a deletion mutation (empty replace) is allowed and applied literally', () => {
  // Deleting a guard clause is the canonical mutation, so `replace: ''` must be a
  // valid entry rather than a validation error — it was rejected as "missing", and
  // the workaround was a fake non-empty replacement that no longer described the
  // break being tested.
  withTree(
    [entry({ find: "export const VALUE = 'expected';\n", replace: '', expect_detail: 'src.mjs' })],
    {},
    (dir) => {
      const { status, out } = run(dir);
      assert.doesNotMatch(out, /missing "replace"/);
      assert.match(out, /killed/);
      assert.equal(status, 0);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
});

test('a gate that hangs is RED with a timeout verdict, not a hang', () => {
  // Several manifest entries deliberately reintroduce a spin, because the bug class
  // they pin is "a global regex replace never terminates". Without a bound here the
  // gate ran until the allocator gave up — 6.2 GB and climbing locally, 3m16s in CI
  // — and a SIGKILL under a memory cap produced no error line at all, so the verdict
  // degraded to WRONG REASON naming nothing about memory.
  withTree(
    [entry({ gate: 'node-test:fx/hang.test.mjs', expect_detail: 'timed out' })],
    {},
    (dir) => {
      writeFileSync(
        join(dir, 'fx', 'hang.test.mjs'),
        // Green when VALUE is intact, spins when it is not — the shape of the real
        // entries, without the multi-GB appetite.
        "import { VALUE } from './src.mjs';\n" + "if (VALUE !== 'expected') { for (;;) {} }\n",
      );
      const { status, out } = run(dir, [], { MUTATION_TIMEOUT_MS: '3000' });
      assert.match(out, /killed/);
      assert.match(out, /timed out/);
      assert.equal(status, 0);
      assert.equal(sourceOf(dir), SOURCE);
    },
  );
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
