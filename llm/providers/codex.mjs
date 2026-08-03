import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const kind = 'codex';

export function run(prompt, ctx) {
  writeFileSync(join(ctx.cwd, '.agent-prompt.txt'), prompt);
  const args = ['--full-auto', '-p', prompt];
  console.log(`[llm:codex] spawning in ${ctx.cwd}`);
  const r = spawnSync('codex', args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...(ctx.env || {}) },
    timeout: 0,
    stdio: 'inherit',
  });
  return { status: r.status ?? 1, provider: 'codex' };
}
