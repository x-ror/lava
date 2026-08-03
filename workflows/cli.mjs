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
import { listOpenIssues, selectReadyIssues, isAgentReady } from '../runtime/github.mjs';
import { buildDag, explain, UNTIERED } from '../runtime/dag.mjs';

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
    console.log(`usage: workflows/cli.mjs run|trigger|status|queue

  queue [--all]   show the derived task DAG: order, tiers, what blocks what.
                  Without --all, only issues labelled agent-ready (what would
                  actually run). With --all, the full derived order.`);
    process.exit(0);
  }

  if (cmd === 'queue') {
    const open = listOpenIssues();
    const dag = buildDag(open);
    const shown = selectReadyIssues({ includeUnlabeled: !!flags.all });
    const gated = selectReadyIssues();
    console.log(
      `${open.length} open · ${shown.length} shown · ${gated.length} agent-ready` +
        (flags.all ? '  (--all: ignoring the agent-ready gate)' : ''),
    );
    for (const i of shown) {
      const t = dag.tierOf(i.number);
      const e = explain(dag, i);
      const tag = [
        e.epics.length ? `epic ${e.epics.map((n) => '#' + n).join(',')}` : null,
        isAgentReady(i) ? 'READY' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      console.log(
        `  T${t === UNTIERED ? '?' : t}  #${String(i.number).padEnd(4)} ${i.title.slice(0, 64)}${tag ? `   [${tag}]` : ''}`,
      );
    }
    const held = open
      .map((i) => [i, dag.blockers(i.number)])
      .filter(([, b]) => b.length)
      .sort((a, b) => a[0].number - b[0].number);
    if (held.length) {
      console.log(`\nheld back by open dependencies (${held.length}):`);
      for (const [i, b] of held) {
        console.log(`  #${String(i.number).padEnd(4)} ← ${b.map((n) => '#' + n).join(', ')}`);
      }
    }
    return;
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
