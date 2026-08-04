/**
 * Workflow Engine — LangGraph-style state graph over named commands.
 *
 * Nodes are either:
 *   - command: invokeCommand(name)  (the same entry humans use via slash cmds)
 *   - system:  built-in action (select, draft_pr, …)
 *   - terminal: end state
 *
 * Edges are static next / on_fail / on_ship / on_block / on_stall.
 * Durable state is persisted by durable.mjs so long DAGs survive process restart.
 */
import { invokeCommand } from '../commands/invoke.mjs';
import { savePlan } from './durable.mjs';

/**
 * @param {{
 *   graph: { entry: string, nodes: Record<string, object> },
 *   state: object,
 *   handlers?: Record<string, (state, node) => Promise<object|void>>,
 *   onStep?: (step) => void,
 *   maxSteps?: number,
 *   invoke?: (command: string, opts: object) => Promise<object>,
 * }} opts
 *   `invoke` defaults to the real command layer and exists so the graph — the
 *   verdict routing especially — can be tested without spawning an LLM or a
 *   worktree. Untested routing here is how a fail-open gate stays invisible.
 */
export async function runGraph(opts) {
  const { graph, handlers = {}, onStep, maxSteps = 50, invoke = invokeCommand } = opts;
  let state = {
    ...opts.state,
    node: opts.state.node || graph.entry,
    history: opts.state.history || [],
  };
  let steps = 0;

  while (steps < maxSteps) {
    steps++;
    const nodeName = state.node;
    const node = graph.nodes[nodeName];
    if (!node) {
      state.status = 'error';
      state.error = `unknown node: ${nodeName}`;
      break;
    }

    if (node.type === 'terminal') {
      state.status = node.status || 'done';
      state.terminal = true;
      if (onStep) onStep({ node: nodeName, type: 'terminal', state });
      break;
    }

    let result = null;
    let next = node.next;

    if (node.type === 'command') {
      result = await invoke(node.command, {
        issue: state.issue,
        provider: state.provider,
        cwd: state.wt,
        branch: state.branch,
        env: state.env,
        worktree: false, // already bootstrapped at select/pipeline level
        source: 'workflow',
        implementProvider: state.implementProvider,
        gateLog: state.gateLog,
        findingsPath: state.findingsPath,
        // The aggregator downgrades to BLOCK / SHIP-AFTER on these. They come
        // from the pipeline's own gate run, not from the agent's self-report.
        gateRed: state.gateRed === true,
        gateUnrun: state.gateUnrun === true,
        plan: state.plan,
        dryRun: state.dryRun,
        maxTurns: state.maxTurns,
        extra: state.extra,
      });

      // Carry worktree forward
      if (result.wt) state.wt = result.wt;
      if (result.branch) state.branch = result.branch;
      if (result.env) state.env = result.env;
      if (result.provider && node.command === 'odin-feature') {
        state.implementProvider = result.provider;
      }
      if (result.verdict) state.verdict = result.verdict;
      if (result.plan) {
        state.plan = result.plan;
        // Outlives the worktree, which is deleted once the PR is open.
        if (state.runId) savePlan(state.runId, result.plan);
      }

      if (node.hard_gate) {
        // Fail closed. Only a machine-readable SHIP / SHIP-AFTER advances.
        //
        // Everything else — BLOCK, a crash, a turn-limit exit, a provider auth
        // error, or a run under provider `none` (which reports ok+skipped) —
        // lands on on_block. Synthesizing SHIP-AFTER from "ok but no findings
        // file" is what let a draft PR open with zero mechanical gates run; the
        // agent's own claim of success is not evidence, the findings file is.
        const v = result.verdict?.verdict;
        if (v === 'SHIP') next = node.on_ship || node.next;
        else if (v === 'SHIP-AFTER') next = node.on_ship_after || node.on_ship || node.next;
        else next = node.on_block || node.on_fail || node.next;

        if (v !== 'SHIP' && v !== 'SHIP-AFTER') {
          state.verdict = result.verdict || {
            verdict: 'BLOCK',
            reason: result.skipped
              ? `hard gate ${node.command} did not run (provider skipped)`
              : `hard gate ${node.command} produced no verdict (exit ${result.status})`,
          };
        }
      } else if (!result.ok) {
        next = node.on_fail || node.next;
      }

      // A planner that concludes the work already exists ends the run.
      //
      // planner.md rule 4 promises exactly this ("do not re-queue
      // implementation") and nothing read it: for #91 the plan came back
      // `terminal: "already-done"` with zero tasks, and the graph went on to
      // spend odin-feature, critic, gates and pr-gate rediscovering that.
      //
      // It lands on needs-human, NOT done, and that is the whole point. The
      // planner was WRONG about #91 — the work was needed and odin-feature did
      // it. A wrong "already-done" that closed the run silently would bury the
      // issue; one that stops and asks costs a human thirty seconds.
      //
      // Applied after the routing above so a hard gate's verdict still wins:
      // a BLOCK is a stronger statement than a plan's opinion.
      if (!node.hard_gate && result.ok && result.plan?.terminal) {
        state.terminalReason = `${node.command}: plan says ${result.plan.terminal}`;
        next = node.on_terminal || 'terminal.needs-human';
      }
    } else if (node.type === 'system') {
      const h = handlers[node.action || nodeName];
      if (h) {
        const patch = await h(state, node);
        if (patch) state = { ...state, ...patch };
      }
      if (state.forceNext) {
        next = state.forceNext;
        delete state.forceNext;
      }
    }

    state.history.push({
      ts: new Date().toISOString(),
      node: nodeName,
      next,
      ok: result?.ok,
      // The effective verdict, which for a hard gate may be the BLOCK this
      // engine assigned because the agent produced none.
      verdict: node.hard_gate ? state.verdict?.verdict : result?.verdict?.verdict,
    });
    if (onStep) onStep({ node: nodeName, next, result, state });

    // A round the fixer never got to attempt is not a round.
    //
    // Observed on #91: the claude CLI exited 1 without doing a turn, three
    // "fix rounds" burned in ninety seconds, and the run closed as
    // needs-human-decision — reporting a code problem when the truth was that
    // nothing had been tried. The budget exists to stop a fixer that cannot
    // solve something, not to count outages.
    //
    // Still bounded: consecutive no-runs stall too, on their own counter, so an
    // unavailable provider ends the run instead of spinning against the graph.
    if (nodeName === 'fixer') {
      const maxR = node.max_rounds || state.maxFixRounds || 3;
      if (result?.didNotRun) {
        state.providerMisses = (state.providerMisses || 0) + 1;
        if (state.providerMisses >= (node.max_provider_misses || 2)) {
          state.stallReason =
            `provider did not run ${state.providerMisses} times in a row ` +
            `(last exit ${result.status}, ${result.durationMs}ms) — no fix was attempted`;
          next = node.on_stall || 'terminal.needs-human';
        }
      } else {
        state.providerMisses = 0;
        state.fixRound = (state.fixRound || 0) + 1;
        if (state.fixRound > maxR) {
          state.stallReason = `fixer ran ${state.fixRound - 1} times without clearing the gate`;
          next = node.on_stall || 'terminal.needs-human';
        }
      }
    }

    state.node = next || nodeName;
    if (!next) {
      state.status = 'stuck';
      break;
    }
  }

  if (steps >= maxSteps && !state.terminal) {
    state.status = 'max-steps';
  }
  return state;
}
