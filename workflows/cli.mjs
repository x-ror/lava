#!/usr/bin/env node
/**
 * Workflow CLI
 *
 *   node workflows/cli.mjs run [--once|--max N|--issues a,b|--provider grok]
 *   node workflows/cli.mjs trigger issues [--once]
 *   node workflows/cli.mjs trigger schedule
 *   node workflows/cli.mjs status
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline } from './pipeline.mjs';
import { pollAndDispatch } from './triggers/issues.mjs';
import { STATE_DIR } from '../runtime/paths.mjs';

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith('--')) {
        flags[k] = n;
        i++;
      } else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (!cmd || cmd === 'help') {
    console.log(`usage: workflows/cli.mjs run|trigger|status|resume`);
    process.exit(0);
  }

  if (cmd === 'run') {
    const r = await runPipeline({
      once: !!flags.once,
      max: flags.max ? Number(flags.max) : undefined,
      issues: flags.issues
        ? String(flags.issues)
            .split(',')
            .map((s) => Number(s.trim()))
        : undefined,
      provider: flags.provider || flags.agent,
      dryRun: !!flags['dry-run'],
      createPr: flags['no-pr'] ? false : true,
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'trigger') {
    const kind = rest[0] || 'issues';
    if (kind === 'issues') {
      const r = await pollAndDispatch({
        once: !!flags.once,
        provider: flags.provider,
        max: flags.max ? Number(flags.max) : undefined,
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (kind === 'schedule') {
      const r = await runPipeline({
        max: flags.max ? Number(flags.max) : 5,
        provider: flags.provider,
      });
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.error('unknown trigger', kind);
    process.exit(2);
  }

  if (cmd === 'status') {
    const last = join(STATE_DIR, 'last-run.json');
    if (existsSync(last)) {
      console.log(readFileSync(last, 'utf8'));
    } else {
      console.log(JSON.stringify({ status: 'no runs yet' }));
    }
    const runsDir = join(STATE_DIR, 'runs');
    if (existsSync(runsDir)) {
      const runs = readdirSync(runsDir);
      console.log(JSON.stringify({ runs: runs.slice(-10) }, null, 2));
    }
    return;
  }

  console.error('unknown command', cmd);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
