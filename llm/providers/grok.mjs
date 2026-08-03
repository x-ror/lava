import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const kind = 'grok';

export function run(prompt, ctx) {
  const promptPath = join(ctx.cwd, `.agent-prompt-${Date.now()}.txt`);
  writeFileSync(promptPath, prompt);
  writeFileSync(join(ctx.cwd, '.agent-prompt.txt'), prompt);
  const args = [
    '--cwd',
    ctx.cwd,
    '--always-approve',
    '--max-turns',
    String(ctx.maxTurns ?? 100),
    '--prompt-file',
    promptPath,
  ];
  console.log(`[llm:grok] spawning in ${ctx.cwd} max-turns=${ctx.maxTurns ?? 100}`);
  const r = spawnSync('grok', args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...(ctx.env || {}) },
    timeout: 0,
    stdio: 'inherit',
  });
  return { status: r.status ?? 1, provider: 'grok' };
}
