/**
 * Worktree isolation — the two properties the pipeline depends on and that a
 * rename silently broke once: the path carries the pid, and a second run for the
 * same task does not die on an existing branch.
 *
 * Driven through the real script in a throwaway git repo. PATH is stripped to
 * /usr/bin:/bin so the bootstrap takes its "no bun/npm" branch instead of
 * installing node_modules for a fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WORKTREE_BOOTSTRAP } from './paths.mjs';

const MINIMAL_PATH = '/usr/bin:/bin';

function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lava-wt-test-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'runtime'), { recursive: true });
  copyFileSync(WORKTREE_BOOTSTRAP, join(repo, 'runtime/worktree-bootstrap.sh'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'master', '.');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  writeFileSync(join(repo, 'f.txt'), 'hi\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { dir, repo, git };
}

function bootstrap(repo, branch) {
  const r = spawnSync(join(repo, 'runtime/worktree-bootstrap.sh'), [branch, 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: MINIMAL_PATH, HOME: process.env.HOME },
  });
  assert.equal(r.status, 0, `bootstrap failed:\n${r.stderr}\n${r.stdout}`);
  const out = `${r.stdout}\n${r.stderr}`;
  const wt = out.match(/export LAVA_WORKTREE=(\S+)/)?.[1];
  assert.ok(wt, `no LAVA_WORKTREE in:\n${out}`);
  const env = {};
  for (const line of readFileSync(join(wt, '.agent-env'), 'utf8').split('\n')) {
    const m = line.match(/^export (\w+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return { wt, env };
}

test('two bootstraps of one task get distinct worktree paths', () => {
  const { dir, repo } = fixtureRepo();
  try {
    const a = bootstrap(repo, 'agent/335');
    const b = bootstrap(repo, 'agent/335');
    // The pid suffix is the whole point: with a literal '$' both runs resolve to
    // one path and the second dies on the existence guard.
    assert.notEqual(a.wt, b.wt);
    assert.match(a.wt, /\/lava-wt-agent-335-\d+/);
    assert.match(b.wt, /\/lava-wt-agent-335-\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run for one task gets a fresh branch, and reports it', () => {
  const { dir, repo, git } = fixtureRepo();
  try {
    const a = bootstrap(repo, 'agent/335');
    const b = bootstrap(repo, 'agent/335');
    assert.equal(a.env.LAVA_BRANCH, 'agent/335');
    assert.notEqual(b.env.LAVA_BRANCH, a.env.LAVA_BRANCH);
    assert.match(b.env.LAVA_BRANCH, /^agent\/335-\d+/);
    // Both branches must really exist — the PR head is whatever was created.
    for (const branch of [a.env.LAVA_BRANCH, b.env.LAVA_BRANCH]) {
      git('show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrapWorktree refuses a task id that is not a safe branch component', async () => {
  const { bootstrapWorktree } = await import('./worktree.mjs');
  for (const bad of ['../../etc', 'a b', '-x', '', 'a;rm -rf /']) {
    assert.throws(() => bootstrapWorktree(bad), /unsafe task id/, `accepted ${bad}`);
  }
});
