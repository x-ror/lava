import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const kind = 'none';

export function run(prompt, ctx) {
  const path = join(ctx.cwd, '.agent-prompt.txt');
  writeFileSync(path, prompt);
  console.log(`[llm:none] wrote prompt → ${path} (${prompt.length} chars)`);
  return { status: 0, skipped: true, provider: 'none' };
}
