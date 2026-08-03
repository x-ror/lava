/**
 * Trigger: GitHub issues (poll mode).
 * When an issue is opened or labeled agent-ready / lava-ready, start pipeline.
 *
 *   node workflows/triggers/issues.mjs --poll
 *   node workflows/triggers/issues.mjs --once
 *
 * For true webhooks, point a GitHub Action or gateway at:
 *   node commands/index.mjs run-pipeline --issues <n> --source trigger
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listOpenIssues, parseLavaTask } from '../../runtime/github.mjs';
import { runPipeline } from '../pipeline.mjs';
import { STATE_DIR } from '../../runtime/paths.mjs';

const SEEN = join(STATE_DIR, 'trigger-issues-seen.json');

function loadSeen() {
  if (!existsSync(SEEN)) return { numbers: [] };
  return JSON.parse(readFileSync(SEEN, 'utf8'));
}

function saveSeen(seen) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SEEN, JSON.stringify(seen, null, 2));
}

export function discoverTriggeredIssues() {
  const open = listOpenIssues();
  const out = [];
  for (const issue of open) {
    const labels = (issue.labels || []).map((l) => l.name);
    const ready =
      labels.includes('agent-ready') ||
      labels.includes('lava-ready') ||
      !!parseLavaTask(issue.body);
    if (ready) out.push(issue);
  }
  return out;
}

export async function pollAndDispatch(opts = {}) {
  const seen = loadSeen();
  const seenSet = new Set(seen.numbers || []);
  const candidates = discoverTriggeredIssues();
  const fresh = candidates.filter((i) => !seenSet.has(i.number));

  if (!fresh.length) {
    console.log('[trigger:issues] no new ready issues');
    return { dispatched: [] };
  }

  console.log(`[trigger:issues] dispatching: ${fresh.map((i) => '#' + i.number).join(', ')}`);

  const result = await runPipeline({
    issues: fresh.map((i) => i.number),
    provider: opts.provider || process.env.AGENT_PROVIDER || 'auto',
    once: opts.once,
    max: opts.max || fresh.length,
    createPr: opts.createPr !== false,
    source: 'trigger',
  });

  for (const i of fresh) seenSet.add(i.number);
  saveSeen({ numbers: [...seenSet], updated: new Date().toISOString() });
  return { dispatched: fresh.map((i) => i.number), result };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once') || args.includes('--poll') || args.length === 0;
  await pollAndDispatch({
    once: args.includes('--once'),
    provider: process.env.AGENT_PROVIDER,
  });
  // --poll without loop: single tick (cron / systemd timer expected)
  if (!once) {
    /* reserved for future long-poll */
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('issues.mjs');
if (isMain)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
