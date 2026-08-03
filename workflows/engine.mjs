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

/**
 * @param {{
 *   graph: { entry: string, nodes: Record<string, object> },
 *   state: object,
 *   handlers?: Record<string, (state, node) => Promise<object|void>>,
 *   onStep?: (step) => void,
 *   maxSteps?: number,
 * }} opts
 */
export async function runGraph(opts) {
  const { graph, handlers = {}, onStep, maxSteps = 50 } = opts;
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
      result = await invokeCommand(node.command, {
        ...state.invokeOpts,
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

      if (node.hard_gate) {
        const v = result.verdict?.verdict;
        if (v === 'SHIP') next = node.on_ship || node.next;
        else if (v === 'SHIP-AFTER') next = node.on_ship_after || node.on_ship || node.next;
        else if (v === 'BLOCK') next = node.on_block || node.on_fail || node.next;
        else if (!result.ok) next = node.on_block || node.on_fail || node.next;
        else {
          // Agent returned ok but no structured verdict: prefer on_ship_after
          // (draft PR allowed; human still reviews). Never invent SHIP.
          next = node.on_ship_after || node.on_ship || node.next;
          if (!state.verdict) {
            state.verdict = {
              verdict: 'SHIP-AFTER',
              reason: 'pr-gate completed without findings file; human review required',
            };
          }
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
      verdict: result?.verdict?.verdict,
    });
    if (onStep) onStep({ node: nodeName, next, result, state });

    // Fixer round accounting
    if (nodeName === 'fixer') {
      state.fixRound = (state.fixRound || 0) + 1;
      const maxR = node.max_rounds || state.maxFixRounds || 3;
      if (state.fixRound >= maxR && next === 'pr-gate') {
        // allow one more pr-gate; stall handled after failed pr-gate
      }
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
