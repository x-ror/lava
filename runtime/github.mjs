import { spawnSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

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

export function listOpenIssues() {
  try {
    return ghJson([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,labels,body',
    ]);
  } catch (e) {
    console.error('gh issue list failed:', e.message);
    return [];
  }
}

export function isHumanOnly(issue) {
  const title = (issue.title || '').toLowerCase();
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes('needs-human') || labels.includes('human-only')) return true;
  if (/\bbench-gate\b/.test(title) && /threshold|cap|master/.test(title)) return true;
  return false;
}

export function selectReadyIssues(opts = {}) {
  const open = listOpenIssues();
  if (opts.issues?.length) {
    return opts.issues
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
  }
  const scored = [];
  for (const issue of open) {
    if (isHumanOnly(issue)) continue;
    const labels = (issue.labels || []).map((l) => l.name);
    const ready =
      labels.includes('agent-ready') || labels.includes('lava-ready') || parseLavaTask(issue.body);
    if (!ready && !opts.includeUnlabeled) continue;
    const meta = parseLavaTask(issue.body) || {};
    const blocked = meta['blocked-by'] || meta.blocked_by || '[]';
    if (blocked !== '[]' && blocked !== '' && blocked !== 'none') continue;
    const pri = meta.priority || 'P2';
    const rank = pri === 'P0' ? 0 : pri === 'P1' ? 1 : 2;
    scored.push({ issue, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.issue.number - b.issue.number);
  return scored.map((s) => s.issue);
}

export function createDraftPr({ title, body, branch, base = 'master', cwd }) {
  const push = spawnSync('bash', ['-lc', `git push -u origin "${branch}"`], {
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
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url'], {
      encoding: 'utf8',
      cwd: ROOT,
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
