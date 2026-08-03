import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

/**
 * @param {string} cmd
 * @param {{ cwd?: string, env?: object, timeout?: number }} [opts]
 */
export function sh(cmd, opts = {}) {
  return spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout ?? 0,
    maxBuffer: 20 * 1024 * 1024,
  });
}

export function commandExists(bin) {
  const r = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}
