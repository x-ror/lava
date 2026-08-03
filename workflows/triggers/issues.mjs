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

/** Give up on an issue after this many failed pipeline attempts. */
const MAX_ATTEMPTS = Number(process.env.AGENT_TRIGGER_MAX_ATTEMPTS || 3);

/**
 * Dispatch ledger: `{ "335": { status, attempts, ts, updatedAt } }`.
 *
 * Was a flat list of numbers marked seen right after dispatch regardless of
 * outcome, which made every failure permanent — the issue could never be picked
 * up again, and re-labelling it did nothing either.
 */
/**
 * @param {string|null} text raw ledger file contents
 * @returns {{ issues: Record<string, object> }}
 */
export function parseLedger(text) {
  if (!text) return { issues: {} };
  try {
    const raw = JSON.parse(text);
    if (raw.issues) return raw;
    // Migrate the old flat-list form. Those numbers were marked at dispatch
    // time, so all that is known is "do not pick this up again" — record them
    // as done rather than inventing a retry budget for history.
    const issues = {};
    for (const n of raw.numbers || []) issues[n] = { status: 'done', attempts: 1 };
    return { issues };
  } catch {
    // A corrupt ledger must not wedge the trigger permanently.
    return { issues: {} };
  }
}

function loadSeen() {
  return parseLedger(existsSync(SEEN) ? readFileSync(SEEN, 'utf8') : null);
}

function saveSeen(seen) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SEEN, JSON.stringify({ ...seen, updated: new Date().toISOString() }, null, 2));
}

/**
 * @param {object} issue
 * @param {object} record previous ledger entry, if any
 * @returns {{ dispatch: boolean, reason: string }}
 */
export function shouldDispatch(issue, record) {
  if (!record) return { dispatch: true, reason: 'new' };
  if (record.updatedAt && issue.updatedAt && record.updatedAt !== issue.updatedAt) {
    return { dispatch: true, reason: 'issue updated since last run' };
  }
  if (record.status === 'done') return { dispatch: false, reason: 'already completed' };
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    return { dispatch: false, reason: `gave up after ${record.attempts} attempts` };
  }
  return { dispatch: true, reason: `retry ${(record.attempts || 0) + 1}/${MAX_ATTEMPTS}` };
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
  const candidates = discoverTriggeredIssues();
  const fresh = [];
  for (const issue of candidates) {
    const { dispatch, reason } = shouldDispatch(issue, seen.issues[issue.number]);
    if (dispatch) fresh.push(issue);
    else console.log(`[trigger:issues] #${issue.number} skipped — ${reason}`);
  }

  if (!fresh.length) {
    console.log('[trigger:issues] no new ready issues');
    return { dispatched: [] };
  }

  console.log(`[trigger:issues] dispatching: ${fresh.map((i) => '#' + i.number).join(', ')}`);

  // Count the attempt before running: a crash mid-pipeline must still burn an
  // attempt, or a reproducible crash becomes an infinite poll loop.
  for (const i of fresh) {
    const prev = seen.issues[i.number] || {};
    seen.issues[i.number] = {
      status: 'running',
      attempts: (prev.attempts || 0) + 1,
      ts: new Date().toISOString(),
      updatedAt: i.updatedAt || null,
    };
  }
  saveSeen(seen);

  let result;
  try {
    result = await runPipeline({
      issues: fresh.map((i) => i.number),
      provider: opts.provider || process.env.AGENT_PROVIDER || 'auto',
      once: opts.once,
      max: opts.max || fresh.length,
      createPr: opts.createPr !== false,
      source: 'trigger',
    });
  } finally {
    saveSeen(seen);
  }

  // Only a run that actually finished marks the issue done; anything else stays
  // retryable until MAX_ATTEMPTS.
  for (const r of result.results || []) {
    const rec = seen.issues[r.issue];
    if (!rec) continue;
    rec.status = r.ok ? 'done' : r.status === 'skipped' ? 'skipped' : 'failed';
    rec.pr = r.pr || null;
  }
  saveSeen(seen);
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
