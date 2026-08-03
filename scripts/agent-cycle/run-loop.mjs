#!/usr/bin/env node
// Agent-cycle drain loop — the command that "keeps going down the list".
//
//   node scripts/agent-cycle/run-loop.mjs              # process ready issues until empty/budget
//   node scripts/agent-cycle/run-loop.mjs --once       # one issue then stop
//   node scripts/agent-cycle/run-loop.mjs --max 3
//   node scripts/agent-cycle/run-loop.mjs --issues 335,247,332
//   node scripts/agent-cycle/run-loop.mjs --agent grok # or claude | none
//   node scripts/agent-cycle/run-loop.mjs --dry-run    # select+plan+bootstrap only, no agent/PR
//
// Per issue:
//   select → worktree → implement agent → gates → review agent → fix rounds
//   → draft PR → optionally open follow-up issues → next
//
// Never merges to master. Never self-waives P1. Human-only paths skip.

import { spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routePaths } from './route-gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_DIR = join(ROOT, '.agent-cycle');
const LOG = join(STATE_DIR, 'run-loop.log');
const MAX_FIX_ROUNDS = 3;
const HOT = [
  'pkg/runtime/js/internal/loader.js',
  'pkg/runtime/eventloop/',
  'pkg/runtime/require.odin',
  'pkg/runtime/module_resolution.odin',
  'pkg/jsc/host_function.odin',
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LOG, line + '\n');
}

function sh(cmd, opts = {}) {
  const r = spawnSync('bash', ['-lc', cmd], {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: opts.timeout ?? 0,
    maxBuffer: 20 * 1024 * 1024,
  });
  return r;
}

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'gh failed');
  return JSON.parse(r.stdout);
}

function parseArgs(argv) {
  const o = {
    once: false,
    max: 20,
    issues: null,
    agent: process.env.AGENT_CYCLE_AGENT || 'auto',
    dryRun: false,
    skipReview: false,
    createPr: true,
    maxTurns: Number(process.env.AGENT_CYCLE_MAX_TURNS || 100),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--skip-review') o.skipReview = true;
    else if (a === '--no-pr') o.createPr = false;
    else if (a === '--max') o.max = Number(argv[++i]);
    else if (a === '--issues') o.issues = argv[++i].split(',').map((s) => Number(s.trim()));
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '--max-turns') o.maxTurns = Number(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      o.help = true;
    }
  }
  if (o.once) o.max = 1;
  return o;
}

function resolveAgent(name) {
  if (name === 'none') return { kind: 'none' };
  if (name === 'grok' || (name === 'auto' && commandExists('grok'))) {
    return { kind: 'grok', bin: 'grok' };
  }
  if (name === 'claude' || (name === 'auto' && commandExists('claude'))) {
    return { kind: 'claude', bin: 'claude' };
  }
  if (name === 'auto') return { kind: 'none' };
  throw new Error(`unknown agent: ${name}`);
}

function commandExists(bin) {
  const r = spawnSync('bash', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}

function listOpenIssues() {
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
    log(`gh issue list failed: ${e.message}`);
    return [];
  }
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

function isHumanOnly(issue) {
  const title = (issue.title || '').toLowerCase();
  const labels = (issue.labels || []).map((l) => l.name);
  if (labels.includes('needs-human') || labels.includes('human-only')) return true;
  if (/\bbench-gate\b/.test(title) && /threshold|cap|master/.test(title)) return true;
  return false;
}

function selectQueue(opts) {
  const open = listOpenIssues();
  if (opts.issues && opts.issues.length) {
    return opts.issues
      .map((n) => open.find((i) => i.number === n) || { number: n, title: `(#${n})`, body: '', labels: [] })
      .filter((i) => !isHumanOnly(i));
  }
  const scored = [];
  for (const issue of open) {
    if (isHumanOnly(issue)) continue;
    const meta = parseLavaTask(issue.body) || {};
    const blocked = meta['blocked-by'] || meta.blocked_by || '[]';
    if (blocked !== '[]' && blocked !== '' && blocked !== 'none') continue;
    const pri = meta.priority || 'P2';
    const rank = pri === 'P0' ? 0 : pri === 'P1' ? 1 : 2;
    scored.push({ issue, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.issue.number - b.issue.number);
  if (scored.length) return scored.map((s) => s.issue);

  // bucket-a fallback from plan
  const fallback = [335, 332, 252, 250, 247, 245, 226, 193, 86, 85, 64, 66];
  return fallback
    .map((n) => open.find((i) => i.number === n))
    .filter(Boolean)
    .filter((i) => !isHumanOnly(i));
}

function bootstrapWorktree(issueNumber) {
  const branch = `agent-cycle/${issueNumber}`;
  const r = sh(`"${ROOT}/scripts/agent-cycle/worktree-bootstrap.sh" "${branch}" HEAD`, {
    timeout: 600_000,
  });
  if (r.status !== 0) {
    throw new Error(`worktree bootstrap failed:\n${r.stderr || r.stdout}`);
  }
  // Parse LAVA_WORKTREE from output
  const out = `${r.stdout}\n${r.stderr}`;
  const m = out.match(/export LAVA_WORKTREE=(\S+)/) || out.match(/worktree ready: (\S+)/);
  if (!m) throw new Error(`could not parse worktree path from:\n${out}`);
  const wt = m[1];
  const envFile = join(wt, '.agent-cycle-env');
  const env = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const mm = line.match(/^export (\w+)=(.*)$/);
      if (mm) env[mm[1]] = mm[2];
    }
  }
  env.LAVA_WORKTREE = wt;
  env.LAVA_BIN = env.LAVA_BIN || join(wt, 'bin/lava');
  return { wt, branch, env };
}

function buildPrompt(kind, issue, ctx) {
  const base = `You are in the Lava agent-cycle loop. Repo rules: CLAUDE.md, docs/agent-cycle-plan.md.
Work ONLY on GitHub issue #${issue.number}: ${issue.title}
Working directory is the task worktree: ${ctx.wt}
Branch: ${ctx.branch}
Use LAVA_BIN=${ctx.env.LAVA_BIN || join(ctx.wt, 'bin/lava')} and make from this directory.
Never: merge to master, git stash, widen known-lava-gaps, UPDATE primordials baselines, NODE_BIN=lava, RUN_LAVA=0, skip mutation, loosen bench caps.
Max ${MAX_FIX_ROUNDS} fix rounds for review feedback.
`;

  if (kind === 'implement') {
    return (
      base +
      `
## Phase: IMPLEMENT
1. Read the issue body (gh issue view ${issue.number}) and Acceptance checklist.
2. If non-trivial: design first (odin-feature --design-only style). If you need a human decision, write NEEDS_HUMAN: reason and stop.
3. Write red tests that fail for the stated reason, then implement.
4. make build once; run gates for changed paths:
   node ${ROOT}/scripts/agent-cycle/route-gates.mjs --from-git
   Run every listed target that applies (including non-CI: bun-buffer-tests, api-surface, test-compat-lava-strict, bench-gate, bench-http when routed).
5. Commit on this branch with a conventional message.
6. End with a short summary: files changed, gates run, remaining risks.
`
    );
  }
  if (kind === 'review') {
    return (
      base +
      `
## Phase: REVIEW
1. git diff against the merge-base with master/main.
2. Run mechanical gates that apply (route-gates).
3. Review for: correctness, Node parity, safety, missing tests, gate-weakening.
4. Write findings as JSON to ${join(ctx.wt, '.agent-cycle-findings.json')} matching:
   { "agent": "reviewer", "findings": [{ "id", "severity": "P0|P1|P2|nit", "file", "line", "what", "failure", "evidence", "fix", "confidence" }] }
5. Severity by class: parity/safety/security/gate-weakening never P2.
6. If clean, findings may be [].
`
    );
  }
  if (kind === 'fix') {
    return (
      base +
      `
## Phase: FIX REVIEW
Findings file: ${join(ctx.wt, '.agent-cycle-findings.json')}
Gate failures (if any): ${ctx.gateLog || '(none)'}
Address ALL open P0 and P1. Re-run failed gates. Commit fixes.
Do not waive P1. If blocked, write NEEDS_HUMAN: reason.
`
    );
  }
  return base;
}

function runAgent(agent, prompt, cwd, opts) {
  if (agent.kind === 'none') {
    log(`[agent=none] would run in ${cwd}`);
    log(`--- prompt start ---\n${prompt.slice(0, 500)}...\n--- prompt end ---`);
    writeFileSync(join(cwd, '.agent-cycle-prompt.txt'), prompt);
    return { status: 0, skipped: true };
  }

  const maxTurns = opts.maxTurns;
  let cmd;
  if (agent.kind === 'grok') {
    // headless + always-approve; cwd isolates the worktree
    cmd = [
      agent.bin,
      '-p',
      prompt,
      '--cwd',
      cwd,
      '--always-approve',
      '--max-turns',
      String(maxTurns),
    ];
  } else if (agent.kind === 'claude') {
    // Claude Code headless variants differ; -p is common
    cmd = [agent.bin, '-p', prompt, '--cwd', cwd, '--dangerously-skip-permissions'];
  } else {
    throw new Error(`unsupported agent ${agent.kind}`);
  }

  log(`spawning ${agent.kind} in ${cwd} (max-turns=${maxTurns})`);
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    cwd,
    env: process.env,
    timeout: 0,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (r.stdout) writeFileSync(join(cwd, `.agent-cycle-${Date.now()}.out.txt`), r.stdout);
  if (r.stderr) writeFileSync(join(cwd, `.agent-cycle-${Date.now()}.err.txt`), r.stderr);
  log(`agent exit ${r.status}`);
  return r;
}

function changedFiles(wt) {
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
      cwd: wt,
      encoding: 'utf8',
    }).trim();
    return execFileSync('git', ['diff', '--name-only', base], { cwd: wt, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { cwd: wt, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  }
}

function runGates(wt, env) {
  const files = changedFiles(wt);
  if (!files.length) {
    log('no changed files vs base — running make check only');
    const r = sh('make check', { cwd: wt, env, timeout: 600_000 });
    return { ok: r.status === 0, log: r.stdout + r.stderr, files, targets: ['make check'] };
  }
  const routed = routePaths(files);
  log(`routed targets: ${routed.targets.join(', ')}`);
  if (routed.nonCi.length) log(`non-CI (must pass): ${routed.nonCi.join(', ')}`);

  // Prefer one build then scripts; still use make targets for simplicity
  const logs = [];
  // Always build once
  let r = sh('make build', { cwd: wt, env, timeout: 600_000 });
  logs.push(`make build → ${r.status}\n${r.stderr || ''}`);
  if (r.status !== 0) return { ok: false, log: logs.join('\n'), files, targets: routed.targets };

  for (const t of routed.targets) {
    if (t === 'make build') continue;
    // Skip L2 mutation in the tight loop unless the path requires it (slow)
    if (t === 'make test-mutation') {
      log('skipping test-mutation in loop (run manually / CI)');
      continue;
    }
    log(`gate: ${t}`);
    r = sh(t, { cwd: wt, env, timeout: 1_800_000 });
    logs.push(`${t} → ${r.status}\n${(r.stderr || '').slice(0, 2000)}`);
    if (r.status !== 0) {
      return { ok: false, log: logs.join('\n'), files, targets: routed.targets, failed: t };
    }
  }
  return { ok: true, log: logs.join('\n'), files, targets: routed.targets };
}

function loadFindings(wt) {
  const p = join(wt, '.agent-cycle-findings.json');
  if (!existsSync(p)) return { findings: [] };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { findings: [] };
  }
}

function openDraftPr(issue, branch, wt) {
  // Ensure branch is pushed
  let r = sh(`git push -u origin "${branch}"`, { cwd: wt, timeout: 300_000 });
  if (r.status !== 0) {
    log(`push failed: ${r.stderr || r.stdout}`);
    return null;
  }
  const title = `fix: ${issue.title}`.slice(0, 72);
  const body = `Closes #${issue.number}

## Summary
Automated agent-cycle run for #${issue.number}.

## Test plan
- [ ] Routed gates from agent-cycle/route-gates.mjs
- [ ] Human review before merge

Merge is human-only.
`;
  r = spawnSync(
    'gh',
    ['pr', 'create', '--base', 'master', '--head', branch, '--draft', '--title', title, '--body', body],
    { encoding: 'utf8', cwd: wt, timeout: 120_000 },
  );
  if (r.status !== 0) {
    log(`gh pr create: ${r.stderr || r.stdout}`);
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url'], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    try {
      const arr = JSON.parse(list.stdout || '[]');
      return arr[0]?.url || null;
    } catch {
      return null;
    }
  }
  return (r.stdout || '').trim();
}

function openFollowUpIssues(issue, findings) {
  const actionable = (findings.findings || []).filter(
    (f) => f.severity === 'P0' || f.severity === 'P1',
  );
  const created = [];
  for (const f of actionable.slice(0, 5)) {
    // Prefer fixing on same branch; only open new issue if fix is out of scope
    if (!f.file || f.discard) continue;
    const title = `[follow-up #${issue.number}] ${f.what}`.slice(0, 80);
    const body = `Follow-up from agent-cycle on #${issue.number}.

**Severity:** ${f.severity}
**File:** ${f.file}${f.line != null ? ':' + f.line : ''}
**What:** ${f.what}
**Evidence:** ${f.evidence || f.failure || '(none)'}
**Suggested fix:** ${f.fix || '(none)'}

<!-- lava-task
priority: ${f.severity === 'P0' ? 'P0' : 'P1'}
blocked-by: []
attempts: 0
review-tier: L1
-->
## Acceptance
- [ ] ${f.fix || f.what}
- [ ] regression test if applicable
`;
    const r = spawnSync('gh', ['issue', 'create', '--title', title, '--body', body], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60_000,
    });
    if (r.status === 0) {
      created.push((r.stdout || '').trim());
      log(`opened follow-up issue: ${r.stdout.trim()}`);
    }
  }
  return created;
}

function processIssue(issue, agent, opts) {
  log(`======== issue #${issue.number}: ${issue.title} ========`);
  if (isHumanOnly(issue)) {
    log('skip: needs-human-decision');
    return { status: 'skipped', reason: 'human-only' };
  }

  const { wt, branch, env } = bootstrapWorktree(issue.number);
  log(`worktree ${wt} branch ${branch}`);

  if (opts.dryRun) {
    log('dry-run: stop after bootstrap');
    writeFileSync(join(wt, '.agent-cycle-prompt.txt'), buildPrompt('implement', issue, { wt, branch, env }));
    return { status: 'dry-run', wt, branch };
  }

  // IMPLEMENT
  let r = runAgent(agent, buildPrompt('implement', issue, { wt, branch, env }), wt, opts);
  if (r.status !== 0 && !r.skipped) {
    log('implement agent failed');
    return { status: 'failed', phase: 'implement', wt, branch };
  }

  // GATES + FIX LOOP
  let gates = runGates(wt, env);
  let round = 0;
  while (!gates.ok && round < MAX_FIX_ROUNDS) {
    round++;
    log(`gate fail round ${round}: ${gates.failed || 'unknown'}`);
    r = runAgent(
      agent,
      buildPrompt('fix', issue, { wt, branch, env, gateLog: gates.log.slice(-3000) }),
      wt,
      opts,
    );
    gates = runGates(wt, env);
  }
  if (!gates.ok) {
    log('gates still red after max fix rounds → needs-human');
    return { status: 'needs-human', phase: 'gates', wt, branch, gates };
  }

  // REVIEW
  let findings = { findings: [] };
  if (!opts.skipReview && agent.kind !== 'none') {
    runAgent(agent, buildPrompt('review', issue, { wt, branch, env }), wt, opts);
    findings = loadFindings(wt);
    const openP = (findings.findings || []).filter((f) => f.severity === 'P0' || f.severity === 'P1');
    round = 0;
    while (openP.length && round < MAX_FIX_ROUNDS) {
      round++;
      log(`review fix round ${round}: ${openP.length} open P0/P1`);
      writeFileSync(join(wt, '.agent-cycle-findings.json'), JSON.stringify(findings, null, 2));
      runAgent(
        agent,
        buildPrompt('fix', issue, {
          wt,
          branch,
          env,
          gateLog: JSON.stringify(openP, null, 2),
        }),
        wt,
        opts,
      );
      gates = runGates(wt, env);
      runAgent(agent, buildPrompt('review', issue, { wt, branch, env }), wt, opts);
      findings = loadFindings(wt);
      openP.length = 0;
      openP.push(
        ...(findings.findings || []).filter((f) => f.severity === 'P0' || f.severity === 'P1'),
      );
      if (!gates.ok) break;
    }
    // leftover P0/P1 after max rounds → follow-up issues (do not merge)
    if (openP.length) {
      log(`${openP.length} P0/P1 remain — opening follow-up issues (no silent waive)`);
      openFollowUpIssues(issue, findings);
    }
  }

  let pr = null;
  if (opts.createPr) {
    pr = openDraftPr(issue, branch, wt);
    log(pr ? `draft PR: ${pr}` : 'no PR created');
  }

  return { status: 'done', wt, branch, pr, gates, findings };
}

function printHelp() {
  console.log(`Usage: node scripts/agent-cycle/run-loop.mjs [options]

  --once              Process one issue then exit
  --max N             Max issues this run (default 20)
  --issues a,b,c      Explicit queue (overrides select)
  --agent grok|claude|none|auto   default: auto (grok > claude > none)
  --dry-run           Bootstrap + write prompt only
  --skip-review       Skip review agent phase
  --no-pr             Do not open draft PRs
  --max-turns N       Headless agent turn cap (default 100)

Environment:
  AGENT_CYCLE_AGENT     same as --agent
  AGENT_CYCLE_MAX_TURNS same as --max-turns

Examples:
  # Full drain with Grok headless
  node scripts/agent-cycle/run-loop.mjs --agent grok --max 5

  # You pick first three; auto after that not needed
  node scripts/agent-cycle/run-loop.mjs --issues 335,247,332 --agent grok

  # Only scaffold worktrees + prompts (run agents yourself in each WT)
  node scripts/agent-cycle/run-loop.mjs --issues 335,247 --agent none --dry-run
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  const agent = resolveAgent(opts.agent);
  log(`run-loop start agent=${agent.kind} max=${opts.max} dryRun=${opts.dryRun}`);

  const queue = selectQueue(opts);
  if (!queue.length) {
    log('queue empty — nothing to do');
    process.exit(0);
  }
  log(`queue: ${queue.map((i) => '#' + i.number).join(', ')}`);

  const results = [];
  let n = 0;
  for (const issue of queue) {
    if (n >= opts.max) break;
    n++;
    try {
      const res = processIssue(issue, agent, opts);
      results.push({ issue: issue.number, ...res });
      writeFileSync(join(STATE_DIR, 'last-run.json'), JSON.stringify(results, null, 2));
    } catch (e) {
      log(`error on #${issue.number}: ${e.message}`);
      results.push({ issue: issue.number, status: 'error', error: e.message });
    }
  }

  log('======== run-loop finished ========');
  for (const r of results) {
    log(`  #${r.issue} → ${r.status}${r.pr ? ' ' + r.pr : ''}`);
  }
  console.log(JSON.stringify({ results }, null, 2));
}

main();
