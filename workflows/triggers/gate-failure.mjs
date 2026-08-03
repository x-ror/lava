/**
 * Trigger: after mechanical gates fail, auto-invoke fixer via Command Layer.
 *
 *   node workflows/triggers/gate-failure.mjs --cwd $LAVA_WORKTREE --log gates.log
 */
import { readFileSync } from 'node:fs';
import { invokeCommand } from '../../commands/invoke.mjs';

export async function onGateFailure(opts) {
  const gateLog = opts.logFile ? readFileSync(opts.logFile, 'utf8') : opts.gateLog || '';
  return invokeCommand('fixer', {
    cwd: opts.cwd,
    branch: opts.branch,
    issue: opts.issue,
    provider: opts.provider || process.env.AGENT_PROVIDER || 'auto',
    source: 'trigger',
    worktree: false,
    gateLog,
    extra: `Gate failure trigger. Failed target: ${opts.failed || 'unknown'}. Fix and re-run gates.`,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd') opts.cwd = args[++i];
    else if (args[i] === '--log') opts.logFile = args[++i];
    else if (args[i] === '--issue') opts.issue = Number(args[++i]);
    else if (args[i] === '--failed') opts.failed = args[++i];
    else if (args[i] === '--provider') opts.provider = args[++i];
  }
  if (!opts.cwd) {
    console.error('usage: gate-failure.mjs --cwd <worktree> [--log file] [--issue N]');
    process.exit(2);
  }
  const r = await onGateFailure(opts);
  console.log(JSON.stringify(r, null, 2));
}

const isMain = process.argv[1] && process.argv[1].endsWith('gate-failure.mjs');
if (isMain)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
