/** Run routed mechanical gates in a worktree. */
import { sh } from '../shell.mjs';
import { changedFiles } from '../worktree.mjs';
import { routePaths } from './route-gates.mjs';

/**
 * Run the routed mechanical gates in a worktree.
 *
 * @param {string} wt
 * @param {object} env
 * @param {{ runMutation?: boolean }} [opts]
 *   runMutation defaults to FALSE: `make test-mutation` re-applies every entry in
 *   the manifest and is minutes of work, too slow for the fix→verify loop. The
 *   final pre-PR gate passes true — skipping it there would be gate-weakening
 *   (CLAUDE.md §6), which is exactly what the previous `skipMutation !== false`
 *   spelling did: no caller passed the flag, so mutation never ran at all.
 * @returns {{ ok: boolean, log: string, files: string[], targets: string[], failed?: string }}
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
    if (t === 'make test-mutation' && !opts.runMutation) {
      logs.push('skip test-mutation (tight loop; the pre-PR gate runs it)');
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
