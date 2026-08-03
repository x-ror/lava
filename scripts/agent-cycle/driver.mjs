#!/usr/bin/env node
// Agent-cycle F6 — lightweight driver skeleton.
//
// Does NOT spawn LLM agents itself. It:
//   1. Selects a ready GitHub issue (bucket labels / lava-task HTML comment)
//   2. Bootstraps a worktree
//   3. Prints the implement → L0 → L1 → review checklist
//   4. Records terminal state suggestions (done | blocked | needs-human-decision)
//
// Full autonomous implement/review loops still run under Claude/Grok with
// /agent-cycle + /odin-feature --design-only + /pr-gate. This script is the
// mechanical spine (ports, routing, gate order, requeue policy).
//
// Usage:
//   node scripts/agent-cycle/driver.mjs status
//   node scripts/agent-cycle/driver.mjs select
//   node scripts/agent-cycle/driver.mjs plan <issue-number>
//   node scripts/agent-cycle/driver.mjs route --from-git
//   node scripts/agent-cycle/driver.mjs run [--once|--max N|--issues a,b|--agent grok]
//     → delegates to run-loop.mjs (full drain: worktree → agent → gates → PR → next)

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routePaths } from './route-gates.mjs';
import { aggregate } from './aggregate-verdict.mjs';
// spawnSync used by `run` → run-loop.mjs

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_DIR = join(ROOT, '.agent-cycle');
const MAX_ROUNDS = 3;

// Paths that force needs-human-decision before spawn (plan F6 / #336).
const HUMAN_ONLY_PATHS = [
  /^bench\/thresholds\.json$/,
  /^tests\/node-compat\/pollution-baseline\.json$/,
  /^tests\/mutation-manifest\.json$/,
];

// Shared hot files — serial only (blocks-surface computed).
const HOT_SURFACE = [
  'pkg/runtime/js/internal/loader.js',
  'pkg/runtime/eventloop/loop.odin',
  'pkg/runtime/eventloop/loop_linux.odin',
  'pkg/runtime/require.odin',
  'pkg/jsc/host_function.odin',
];

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'gh failed');
  return r.stdout;
}

function parseLavaTask(body) {
  const m = body && body.match(/<!--\s*lava-task\s*([\s\S]*?)-->/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return meta;
}

function listOpenIssues() {
  try {
    const raw = gh([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,labels,body',
    ]);
    return JSON.parse(raw);
  } catch (e) {
    console.error('gh issue list failed:', e.message);
    return [];
  }
}

function isHumanOnlyIssue(issue) {
  const title = (issue.title || '').toLowerCase();
  if (/\bbench-gate\b/.test(title) && /threshold|cap|master/.test(title)) return true;
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes('needs-human') || labels.includes('human-only')) return true;
  return false;
}

function cmdStatus() {
  console.log('agent-cycle driver — status');
  console.log('plan: docs/agent-cycle-plan.md');
  console.log('max review-fix rounds:', MAX_ROUNDS);
  console.log('hot surface (serial):', HOT_SURFACE.join(', '));
  if (existsSync(join(STATE_DIR, 'state.json'))) {
    console.log('state:', readFileSync(join(STATE_DIR, 'state.json'), 'utf8'));
  } else {
    console.log('state: (none yet)');
  }
  const issues = listOpenIssues();
  console.log('open issues:', issues.length);
  const withMeta = issues.filter((i) => parseLavaTask(i.body));
  console.log('with lava-task block:', withMeta.length);
  const human = issues.filter(isHumanOnlyIssue);
  console.log('heuristic human-only:', human.map((i) => '#' + i.number).join(', ') || '(none)');
}

function cmdSelect() {
  const issues = listOpenIssues();
  // Prefer issues with lava-task and priority P0/P1, no blocked-by.
  const scored = [];
  for (const issue of issues) {
    if (isHumanOnlyIssue(issue)) continue;
    const meta = parseLavaTask(issue.body) || {};
    const blocked = meta['blocked-by'] || meta.blocked_by || '[]';
    if (blocked !== '[]' && blocked !== '' && blocked !== 'none') continue;
    const pri = meta.priority || 'P2';
    const rank = pri === 'P0' ? 0 : pri === 'P1' ? 1 : 2;
    scored.push({ issue, meta, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.issue.number - b.issue.number);
  if (scored.length === 0) {
    // Fall back to plan bucket-(a) numbers if present in title search
    const fallback = [337, 335, 332, 252, 250, 247, 245, 226, 193, 86, 85, 64, 66];
    for (const n of fallback) {
      const hit = issues.find((i) => i.number === n);
      if (hit && !isHumanOnlyIssue(hit)) {
        console.log(
          JSON.stringify(
            { number: hit.number, title: hit.title, source: 'bucket-a-fallback' },
            null,
            2,
          ),
        );
        return;
      }
    }
    console.log(JSON.stringify({ error: 'no ready issue' }));
    process.exit(1);
  }
  const pick = scored[0];
  console.log(
    JSON.stringify(
      {
        number: pick.issue.number,
        title: pick.issue.title,
        meta: pick.meta,
        source: 'lava-task',
      },
      null,
      2,
    ),
  );
}

function cmdPlan(num) {
  const raw = gh(['issue', 'view', String(num), '--json', 'number,title,body,labels']);
  const issue = JSON.parse(raw);
  if (isHumanOnlyIssue(issue)) {
    console.log(
      JSON.stringify(
        {
          number: issue.number,
          terminal: 'needs-human-decision',
          reason: 'human-only heuristic or label',
        },
        null,
        2,
      ),
    );
    return;
  }
  const meta = parseLavaTask(issue.body) || {};
  const branch = `agent-cycle/${issue.number}`;
  const routes = routePaths([]); // filled when paths known
  const plan = {
    number: issue.number,
    title: issue.title,
    meta,
    terminal: null,
    steps: [
      '1. odin-feature --design-only (or write contract + red test first)',
      '2. worktree: scripts/agent-cycle/worktree-bootstrap.sh ' + branch,
      '3. implement in worktree; make -C $LAVA_WORKTREE build once',
      '4. L0: node scripts/agent-cycle/route-gates.mjs --tier L0 <paths> then run targets',
      '5. L1: routed smokes + non-CI targets as listed',
      '6. specialists with findings-schema.json wrapper; aggregate-verdict.mjs',
      '7. if SHIP-AFTER with P0/P1: fix (max ' + MAX_ROUNDS + ' rounds) or needs-human-decision',
      '8. never merge; open PR for human',
    ],
    env_hint: 'source $LAVA_WORKTREE/.agent-cycle-env',
    hot_surface: HOT_SURFACE,
    max_rounds: MAX_ROUNDS,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `issue-${issue.number}.json`), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan, null, 2));
}

function cmdRoute(args) {
  const paths =
    args[0] === '--from-git'
      ? execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
          .split('\n')
          .filter(Boolean)
      : args;
  const r = routePaths(paths);
  for (const p of paths) {
    if (HUMAN_ONLY_PATHS.some((re) => re.test(p.replace(/\\/g, '/')))) {
      r.needs_human_decision = true;
      r.human_reason = `path ${p} is human-only`;
    }
  }
  console.log(JSON.stringify(r, null, 2));
}

function cmdAggregate(files) {
  const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const result = aggregate(reports);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === 'SHIP' ? 0 : result.verdict === 'SHIP-AFTER' ? 1 : 2);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'status':
  case undefined:
    cmdStatus();
    break;
  case 'select':
    cmdSelect();
    break;
  case 'plan':
    cmdPlan(rest[0]);
    break;
  case 'route':
    cmdRoute(rest);
    break;
  case 'aggregate':
    cmdAggregate(rest);
    break;
  case 'run':
  case 'drain':
  case 'loop': {
    // Full automation: select → worktree → agent → gates → PR → next
    const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'run-loop.mjs'), ...rest], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    process.exit(r.status ?? 1);
    break;
  }
  default:
    console.error(
      'usage: driver.mjs status|select|plan <n>|route|aggregate|run [--once|--max N|--issues a,b|--agent grok]',
    );
    process.exit(2);
}
