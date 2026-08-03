import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const kind = 'claude';

export function run(prompt, ctx) {
  writeFileSync(join(ctx.cwd, '.agent-prompt.txt'), prompt);
  // Headless Claude Code: skip interactive permission prompts.
  const skipPerms = '--dangerously-skip-permissions';
  const args = ['--cwd', ctx.cwd, skipPerms, '-p', prompt];
  console.log(`[llm:claude] spawning in ${ctx.cwd}`);
  const r = spawnSync('claude', args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...(ctx.env || {}) },
    timeout: 0,
    stdio: 'inherit',
  });
  return { status: r.status ?? 1, provider: 'claude' };
}
