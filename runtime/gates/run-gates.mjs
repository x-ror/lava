/** Run routed mechanical gates in a worktree. */
import { join } from 'node:path';
import { sh } from '../shell.mjs';
import { changedFiles } from '../worktree.mjs';
import { routePaths } from './route-gates.mjs';

/**
 * @param {string} wt
 * @param {object} env
 * @param {{ skipMutation?: boolean }} [opts]
 */
export function runGates(wt, env, opts = {}) {
  const files = changedFiles(wt);
  if (!files.length) {
    const r = sh('make check', { cwd: wt, env, timeout: 600_000 });
    return {
      ok: r.status === 0,
      log: (r.stdout || '') + (r.stderr || ''),
      files,
      targets: ['make check'],
    };
  }
  const routed = routePaths(files);
  const logs = [];
  let r = sh('make build', { cwd: wt, env, timeout: 600_000 });
  logs.push(`make build → ${r.status}\n${r.stderr || ''}`);
  if (r.status !== 0) {
    return {
      ok: false,
      log: logs.join('\n'),
      files,
      targets: routed.targets,
      failed: 'make build',
    };
  }
  for (const t of routed.targets) {
    if (t === 'make build') continue;
    if (opts.skipMutation !== false && t === 'make test-mutation') {
      logs.push('skip test-mutation in tight loop');
      continue;
    }
    r = sh(t, { cwd: wt, env, timeout: 1_800_000 });
    logs.push(`${t} → ${r.status}\n${(r.stderr || '').slice(0, 2000)}`);
    if (r.status !== 0) {
      return { ok: false, log: logs.join('\n'), files, targets: routed.targets, failed: t };
    }
  }
  return { ok: true, log: logs.join('\n'), files, targets: routed.targets };
}
