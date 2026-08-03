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
import { listOpenIssues, isAgentReady } from '../../runtime/github.mjs';
import { runPipeline } from '../pipeline.mjs';
import { STATE_DIR } from '../../runtime/paths.mjs';
import { withLock } from '../../runtime/lock.mjs';

const SEEN = join(STATE_DIR, 'trigger-issues-seen.json');
const LEDGER_LOCK = 'trigger-issues-seen';

/** Give up on an issue after this many failed pipeline attempts. */
const MAX_ATTEMPTS = Number(process.env.AGENT_TRIGGER_MAX_ATTEMPTS || 3);

/**
 * How long a `running` record owns its issue before it is presumed dead.
 *
 * Matches the CI job's timeout-minutes: a pipeline that outlives it was killed
 * by the runner, not still working.
 */
const RUN_LEASE_MS = Number(process.env.AGENT_TRIGGER_LEASE_MS || 6 * 60 * 60 * 1000);

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
 * @param {number} [now] injectable clock, for the lease check
 * @returns {{ dispatch: boolean, reason: string }}
 */
export function shouldDispatch(issue, record, now = Date.now()) {
  if (!record) return { dispatch: true, reason: 'new' };

  // A run in flight owns the issue, and this check comes FIRST — ahead of the
  // updated-since check, which would otherwise re-dispatch it the moment the
  // agent's own comment or label touched the issue. Nothing downstream would
  // complain: bootstrapWorktree hands each attempt its own worktree and its own
  // suffixed branch, so a double dispatch does not collide, it just quietly
  // does the work twice and opens two PRs.
  if (record.status === 'running') {
    const started = Date.parse(record.ts || '');
    const held = Number.isNaN(started) ? Infinity : now - started;
    if (held < RUN_LEASE_MS) {
      return { dispatch: false, reason: `already running (${Math.round(held / 60000)}m)` };
    }
    // Lease expired, or a record with no timestamp: the holder is gone. Fall
    // through and let the retry budget decide.
  }

  if (record.updatedAt && issue.updatedAt && record.updatedAt !== issue.updatedAt) {
    return { dispatch: true, reason: 'issue updated since last run' };
  }
  if (record.status === 'done') return { dispatch: false, reason: 'already completed' };
  if ((record.attempts || 0) >= MAX_ATTEMPTS) {
    return { dispatch: false, reason: `gave up after ${record.attempts} attempts` };
  }
  return { dispatch: true, reason: `retry ${(record.attempts || 0) + 1}/${MAX_ATTEMPTS}` };
}

/**
 * Issues cleared to run.
 *
 * The gate is the LABEL and only the label. Applying one needs write access to
 * the repository; an issue BODY is written by whoever opened the issue, and this
 * repo is public. Treating a `<!-- lava-task -->` marker as permission let any
 * stranger enqueue themselves — and the dispatch path passes explicit issue
 * numbers to runPipeline, which is the manual-override path that deliberately
 * skips `selectReadyIssues`' own label check. So the body marker was, in effect,
 * an unauthenticated way to start an agent with shell access.
 *
 * The marker still carries data (`blocked-by`), which runtime/dag.mjs reads.
 * Data from an untrusted body is fine; permission from it is not.
 */
export function discoverTriggeredIssues() {
  return listOpenIssues().filter(isAgentReady);
}

/**
 * Claim the issues this poller will work on.
 *
 * Decide and record in ONE locked read-modify-write. Deciding from a ledger read
 * a moment earlier is what lets two pollers both see the same issue as idle and
 * both claim it — the `running` guard only helps if the claim that sets it is
 * atomic with the check that reads it.
 *
 * The lock is held for a file parse and a file write, never across the pipeline.
 */
function claim(candidates) {
  return withLock(LEDGER_LOCK, () => {
    const seen = loadSeen();
    const claimed = [];
    for (const issue of candidates) {
      const { dispatch, reason } = shouldDispatch(issue, seen.issues[issue.number]);
      if (!dispatch) {
        console.log(`[trigger:issues] #${issue.number} skipped — ${reason}`);
        continue;
      }
      const prev = seen.issues[issue.number] || {};
      // Count the attempt before running: a crash mid-pipeline must still burn
      // an attempt, or a reproducible crash becomes an infinite poll loop.
      seen.issues[issue.number] = {
        status: 'running',
        attempts: (prev.attempts || 0) + 1,
        ts: new Date().toISOString(),
        updatedAt: issue.updatedAt || null,
      };
      claimed.push(issue);
    }
    if (claimed.length) saveSeen(seen);
    return claimed;
  });
}

/** Record outcomes, merging into whatever the ledger holds now. */
function release(results) {
  withLock(LEDGER_LOCK, () => {
    const seen = loadSeen();
    for (const r of results) {
      const rec = seen.issues[r.issue];
      if (!rec) continue;
      rec.status = r.ok ? 'done' : r.status === 'skipped' ? 'skipped' : 'failed';
      rec.pr = r.pr || null;
    }
    saveSeen(seen);
  });
}

export async function pollAndDispatch(opts = {}) {
  const fresh = claim(discoverTriggeredIssues());

  if (!fresh.length) {
    console.log('[trigger:issues] no new ready issues');
    return { dispatched: [] };
  }

  console.log(`[trigger:issues] dispatching: ${fresh.map((i) => '#' + i.number).join(', ')}`);

  let result = { results: [] };
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
    // Whatever happened, the claims must not stay `running` — an unreleased
    // claim wedges the issue until its lease expires.
    const seenResults = new Set((result.results || []).map((r) => r.issue));
    release([
      ...(result.results || []),
      ...fresh
        .filter((i) => !seenResults.has(i.number))
        .map((i) => ({ issue: i.number, ok: false })),
    ]);
  }

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
