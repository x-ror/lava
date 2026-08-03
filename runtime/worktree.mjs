import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sh } from './shell.mjs';
import { WORKTREE_BOOTSTRAP } from './paths.mjs';

/**
 * Bootstrap an isolated git worktree for one task.
 * @param {string|number} taskId issue number or task id
 * @param {string} [baseRef]
 */
export function bootstrapWorktree(taskId, baseRef = 'HEAD') {
  const branch = `agent/${taskId}`;
  const r = sh(`"${WORKTREE_BOOTSTRAP}" "${branch}" "${baseRef}"`, {
    timeout: 600_000,
  });
  if (r.status !== 0) {
    throw new Error(`worktree bootstrap failed:\n${r.stderr || r.stdout}`);
  }
  const out = `${r.stdout}\n${r.stderr}`;
  const m = out.match(/export LAVA_WORKTREE=(\S+)/) || out.match(/worktree ready: (\S+)/);
  if (!m) throw new Error(`could not parse worktree path from:\n${out}`);
  const wt = m[1];
  const envFile = join(wt, '.agent-env');
  const env = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const mm = line.match(/^export (\w+)=(.*)$/);
      if (mm) env[mm[1]] = mm[2];
    }
  }
  env.LAVA_WORKTREE = wt;
  env.LAVA_BIN = env.LAVA_BIN || join(wt, 'bin/lava');
  return { wt, branch, env };
}

export function changedFiles(wt) {
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
      cwd: wt,
      encoding: 'utf8',
    }).trim();
    return execFileSync('git', ['diff', '--name-only', base], { cwd: wt, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    try {
      return execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: wt, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
