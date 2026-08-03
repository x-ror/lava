/**
 * Trigger: scheduled drain of ready issues.
 *
 * Intended for cron / systemd timer every 30 minutes:
 *   cd /path/to/lava && node workflows/triggers/schedule.mjs
 *
 * Or:
 *   node workflows/triggers/schedule.mjs --max 3 --provider grok
 */
import { runPipeline } from '../pipeline.mjs';
import { pollAndDispatch } from './issues.mjs';

async function main() {
  const args = process.argv.slice(2);
  let max = 5;
  let provider = process.env.AGENT_PROVIDER || 'auto';
  let mode = 'drain'; // drain | discover
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max') max = Number(args[++i]);
    else if (args[i] === '--provider') provider = args[++i];
    else if (args[i] === '--discover') mode = 'discover';
  }

  if (mode === 'discover') {
    const r = await pollAndDispatch({ max, provider });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const r = await runPipeline({ max, provider, createPr: true });
  console.log(JSON.stringify(r, null, 2));
}

const isMain = process.argv[1] && process.argv[1].endsWith('schedule.mjs');
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
