import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';
import { buildDag, readyQueue, compareByRank } from './dag.mjs';

export function gh(args, opts = {}) {
  const r = spawnSync('gh', args, {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    timeout: opts.timeout ?? 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'gh failed');
  return r.stdout;
}

export function ghJson(args, opts = {}) {
  return JSON.parse(gh(args, opts));
}

export function parseLavaTask(body) {
  const m = body && body.match(/<!--\s*lava-task\s*([\s\S]*?)-->/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return meta;
}

/**
 * Every open issue.
 *
 * The limit is load-bearing, not a round number. `runtime/dag.mjs` reads an edge
 * pointing outside this set as a SATISFIED dependency — that is what makes the
 * graph shrink as work lands, with no checkbox bookkeeping. A truncated page
 * therefore does not lose an issue quietly; it unblocks everything that was
 * waiting on the issues it dropped. So: ask for far more than the tracker holds,
 * and refuse to return a page that came back full.
 *
 * @param {{ limit?: number }} [opts]
 * @throws {Error} when the result is exactly `limit` long and may be truncated.
 */
export function listOpenIssues(opts = {}) {
  const limit = opts.limit ?? 1000;
  let issues;
  try {
    issues = ghJson([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      // updatedAt drives trigger re-dispatch: a relabelled or edited issue is
      // new work even though its number was seen before.
      'number,title,labels,body,updatedAt',
    ]);
  } catch (e) {
    console.error('gh issue list failed:', e.message);
    return [];
  }
  assertNotTruncated(issues, limit);
  return issues;
}

/**
 * @param {object[]} issues
 * @param {number} limit
 * @throws {Error} when the page came back full and may be missing issues.
 */
export function assertNotTruncated(issues, limit) {
  if (issues.length >= limit) {
    throw new Error(
      `open issues hit the ${limit} fetch limit — the dependency graph would read the ` +
        `dropped issues as already closed and unblock work that is still waiting. ` +
        `Raise the limit before draining.`,
    );
  }
}

export function isHumanOnly(issue) {
  const title = (issue.title || '').toLowerCase();
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes('needs-human') || labels.includes('human-only')) return true;
  if (/\bbench-gate\b/.test(title) && /threshold|cap|master/.test(title)) return true;
  return false;
}

/** Labels that grant an issue permission to be worked autonomously. */
export const READY_LABELS = ['agent-ready', 'lava-ready'];

export function isAgentReady(issue) {
  const labels = (issue.labels || []).map((l) => l.name);
  return READY_LABELS.some((l) => labels.includes(l));
}

/**
 * The drain queue.
 *
 * Ordering and blocking are DERIVED from the tracker (see runtime/dag.mjs): tier
 * from the master queue issue, dependencies from `- [ ] #N` task lists. Nothing
 * is authored twice. What is not derived is permission — an issue runs only once
 * a human labels it `agent-ready`, because the tracker states what the work is
 * worth, not whether an agent may do it unattended.
 *
 * The old `priority:` field from `<!-- lava-task -->` is gone: it was a second
 * ordering source for the same issues, no issue in the tracker sets it, and tier
 * already says it. `blocked-by` from that block is still honoured, by dag.mjs.
 *
 * @param {{ issues?: number[], includeUnlabeled?: boolean, queueIssue?: number }} [opts]
 *   `issues` is an explicit manual override and bypasses the label gate.
 */
export function selectReadyIssues(opts = {}) {
  const open = listOpenIssues();

  if (opts.issues?.length) {
    const dag = buildDag(open, opts);
    const picked = opts.issues
      .map(
        (n) =>
          open.find((i) => i.number === n) || {
            number: n,
            title: `(#${n})`,
            body: '',
            labels: [],
          },
      )
      .filter((i) => !isHumanOnly(i));
    // Named explicitly, so run them — but say what they are waiting on, rather
    // than starting work whose prerequisite is still open without a word.
    for (const i of picked) {
      const blockers = dag.blockers(i.number);
      if (blockers.length) {
        console.warn(
          `[queue] #${i.number} requested explicitly but blocked by ${blockers.map((b) => '#' + b).join(', ')}`,
        );
      }
    }
    return picked.sort(compareByRank(dag));
  }

  return readyQueue(open, {
    queueIssue: opts.queueIssue,
    isReady: (issue) => !isHumanOnly(issue) && (opts.includeUnlabeled || isAgentReady(issue)),
  });
}

/**
 * Push `branch` and open a DRAFT PR against `base`.
 *
 * Draft, never merged: `gh pr merge` is denied at the hook layer too, but the
 * call site should not look like it could merge either.
 *
 * @param {{title: string, body: string, branch: string, base?: string, cwd: string}} o
 * @returns {{ok: boolean, url?: string|null, existed?: boolean, error?: string}}
 */
export function createDraftPr({ title, body, branch, base = 'master', cwd }) {
  // argv, not a shell string: `branch` traces back to `--issues`, which is
  // arbitrary CLI input, and `bash -lc` with it interpolated is a command-
  // injection shape even when today's callers happen to pass a number.
  const push = spawnSync('git', ['push', '-u', 'origin', branch], {
    encoding: 'utf8',
    cwd,
    timeout: 300_000,
  });
  if (push.status !== 0) {
    return { ok: false, error: push.stderr || push.stdout };
  }
  const r = spawnSync(
    'gh',
    ['pr', 'create', '--base', base, '--head', branch, '--draft', '--title', title, '--body', body],
    { encoding: 'utf8', cwd, timeout: 120_000 },
  );
  if (r.status !== 0) {
    // `gh pr create` also fails when a PR for this head already exists — that is
    // a re-run, not an error. Query from the worktree so the repo resolved is
    // the branch's own remote.
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url'], {
      encoding: 'utf8',
      cwd,
    });
    try {
      const arr = JSON.parse(list.stdout || '[]');
      return { ok: true, url: arr[0]?.url || null, existed: true };
    } catch {
      return { ok: false, error: r.stderr || r.stdout };
    }
  }
  return { ok: true, url: (r.stdout || '').trim() };
}
