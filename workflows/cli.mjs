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
import { runPipeline, runIssuePipeline } from './pipeline.mjs';
import { pollAndDispatch } from './triggers/issues.mjs';
import { STATE_DIR } from '../runtime/paths.mjs';
import { listOpenIssues, selectReadyIssues, isAgentReady } from '../runtime/github.mjs';
import { buildDag, explain, UNTIERED } from '../runtime/dag.mjs';
import { listRuns, isTerminal, findResumable, checkResumable } from '../runtime/runs.mjs';
import { saveState } from './durable.mjs';

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
    console.log(`usage: workflows/cli.mjs run|trigger|status|queue|resume

  queue [--all]   show the derived task DAG: order, tiers, what blocks what.
                  Without --all, only issues labelled agent-ready (what would
                  actually run). With --all, the full derived order.
  status          In-flight runs (node, age, worktree) and the last completed one.
  resume [runId]  Continue a run that stopped before a terminal node, in the
                  worktree it was already building in. Newest one by default;
                  --issue N picks that issue's. --force reopens a run that
                  already reached a terminal node and resets the fix budget.`);
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
    // `last-run.json` is written when a run FINISHES. Reporting only that made
    // the command answer "no runs yet" while a pipeline was in flight — exactly
    // when the status is worth asking for. The durable state knows better.
    const runs = listRuns();
    const live = runs.filter((r) => r.state && !isTerminal(r.state));
    if (live.length) {
      console.log(`in flight (${live.length}):`);
      for (const r of live) {
        const age = Math.round((Date.now() - r.startedAt) / 60000);
        console.log(
          `  ${r.runId}  #${r.issue ?? '?'}  at ${r.node ?? '?'}  ${age}m  ${r.state.wt || ''}`,
        );
      }
      console.log('  resume with: node workflows/cli.mjs resume');
    }

    const last = join(STATE_DIR, 'last-run.json');
    if (existsSync(last)) {
      console.log('last completed run:');
      console.log(readFileSync(last, 'utf8'));
    } else if (!live.length) {
      console.log(JSON.stringify({ status: 'no runs yet' }));
    }

    if (runs.length) {
      console.log(JSON.stringify({ runs: runs.slice(0, 10).map((r) => r.runId) }, null, 2));
    }
    return;
  }

  if (cmd === 'resume') {
    // --force also widens the search: a terminal run is not "resumable", so
    // findResumable would not offer the very run the operator wants back.
    const target = rest[0]
      ? { runId: rest[0] }
      : findResumable(flags.issue ? { issue: Number(flags.issue) } : {}) ||
        (flags.force
          ? listRuns().find((r) => r.state && (!flags.issue || r.issue === Number(flags.issue)))
          : null);
    if (!target) {
      console.log('nothing to resume — no run stopped before a terminal node');
      return;
    }
    const check = checkResumable(target.runId, undefined, { force: !!flags.force });
    if (!check.ok) {
      console.error(`cannot resume ${target.runId}: ${check.reason}`);
      process.exit(1);
    }
    const { state } = check;
    if (flags.force && isTerminal(state)) {
      // Reopen: clear the terminal marks so the graph runs instead of stopping
      // at the node that closed it. The history is kept — it is the record of
      // why this run needed forcing.
      console.log(`reopening a ${state.status} run (--force)`);
      delete state.status;
      delete state.terminal;
      delete state.stallReason;
      state.fixRound = 0;
      state.providerMisses = 0;
      // Persisted, not just cleared in memory: runIssuePipeline re-reads the
      // state from disk, so an in-memory reopen would be silently discarded and
      // --force would appear to work while changing nothing.
      saveState(target.runId, state);
    }
    console.log(
      `resuming ${target.runId} — issue #${state.issue?.number}, node ${state.node}, worktree ${state.wt}`,
    );
    // The node it stopped in is re-run rather than skipped: a killed agent may
    // have half-applied its turn, and every agent reads the tree before acting,
    // so repeating a step is recoverable where skipping one is not.
    const r = await runIssuePipeline(state.issue, {
      resume: true,
      runId: target.runId,
      provider: flags.provider || state.provider,
      createPr: flags['no-pr'] ? false : state.createPr !== false,
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.error('unknown command', cmd);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
