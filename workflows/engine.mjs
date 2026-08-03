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

    if (nodeName === 'fixer') {
      state.fixRound = (state.fixRound || 0) + 1;
      const maxR = node.max_rounds || state.maxFixRounds || 3;
      if (state.fixRound > maxR) {
        next = node.on_stall || 'terminal.needs-human';
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
