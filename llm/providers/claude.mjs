import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const kind = 'claude';

/**
 * Claude Code CLI (claude): no --cwd flag — working dir is process cwd.
 * Headless: -p/--print + prompt. Permissions: --dangerously-skip-permissions.
 *
 * @param {string} prompt
 * @param {{ cwd: string, maxTurns?: number, env?: object }} ctx
 */
export function run(prompt, ctx) {
  const promptPath = join(ctx.cwd, `.agent-prompt-${Date.now()}.txt`);
  writeFileSync(promptPath, prompt);
  writeFileSync(join(ctx.cwd, '.agent-prompt.txt'), prompt);

  // Prefer prompt-file via stdin when huge (avoid ARG_MAX); else -p <text>.
  // Claude Code: `claude [options] [prompt]` with -p for non-interactive.
  const maxInline = 100_000;
  const useInline = prompt.length <= maxInline;

  const args = ['--dangerously-skip-permissions', '-p'];
  if (useInline) {
    args.push(prompt);
  }

  console.log(`[llm:claude] spawning in ${ctx.cwd} (print mode, skip-permissions)`);
  console.log(`[llm:claude] prompt file: ${promptPath}`);

  const r = spawnSync('claude', args, {
    cwd: ctx.cwd,
    env: { ...process.env, ...(ctx.env || {}) },
    timeout: 0,
    stdio: useInline ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input: useInline ? undefined : prompt,
    maxBuffer: 20 * 1024 * 1024,
  });

  // If stdin path: some CLIs ignore stdin without explicit flag — fall back to -p file content.
  if (!useInline && (r.status ?? 1) !== 0) {
    console.log('[llm:claude] stdin path failed; retrying with -p from file');
    const body = readFileSync(promptPath, 'utf8');
    const r2 = spawnSync(
      'claude',
      ['--dangerously-skip-permissions', '-p', body],
      {
        cwd: ctx.cwd,
        env: { ...process.env, ...(ctx.env || {}) },
        timeout: 0,
        stdio: 'inherit',
      },
    );
    return { status: r2.status ?? 1, provider: 'claude' };
  }

  return { status: r.status ?? 1, provider: 'claude' };
}
