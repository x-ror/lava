import { join } from 'node:path';
import { loadPrompt } from '../agents/registry.mjs';
import { ROOT } from '../runtime/paths.mjs';

/** Forbidden oracle bypasses — spelled so shell hooks never see the assignment form. */
const FORBIDDEN = [
  'NODE' + '_BIN pointing at lava (lava-vs-lava)',
  'RUN' + '_LAVA=0',
  'PROPERTY' + '_RUNS shrink',
  'MUTATION' + '_MANIFEST override',
  'git stash push/pop',
  'widen known-lava-gaps',
  'raise primordials baselines',
  'loosen bench caps',
  'merge to master',
];

/**
 * Render planner's DAG as prose the next agent can act on.
 *
 * Flattened deliberately: the full JSON is on disk at `planPath` for anything
 * that wants to re-read it, and pasting it verbatim spends the context budget on
 * punctuation. What a downstream agent needs is the ordered steps and their
 * acceptance criteria.
 *
 * @param {{tasks?: object[], terminal?: string|null, needs_human?: string|null}} plan
 * @param {string} [planPath]
 */
export function renderPlan(plan, planPath) {
  const lines = [`Plan (from planner${planPath ? `, full JSON at ${planPath}` : ''}):`];
  if (plan.terminal) lines.push(`TERMINAL: ${plan.terminal} — do not re-implement.`);
  if (plan.needs_human) lines.push(`NEEDS HUMAN: ${plan.needs_human}`);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (!tasks.length && !plan.terminal) lines.push('(planner produced no tasks)');
  for (const t of tasks || []) {
    const deps = list(t?.depends_on);
    const human = t?.human_only ? ' [HUMAN ONLY — do not attempt]' : '';
    lines.push(
      `- ${t?.id || '?'}: ${t?.title || '(untitled)'}${deps.length ? ` after ${deps.join(', ')}` : ''}${human}`,
    );
    for (const a of list(t?.acceptance)) lines.push(`    accept: ${a}`);
    const paths = list(t?.paths_hint);
    if (paths.length) lines.push(`    paths: ${paths.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Coerce a field the schema declares as an array.
 *
 * The plan is JSON an LLM wrote, and `JSON.parse` is happy with
 * `"depends_on": "t1"` — a string has `.length`, so the old truthiness check
 * passed and `.join` then threw, taking down an invocation that had already
 * agreed a malformed plan is context rather than a gate.
 */
function list(v) {
  if (Array.isArray(v)) return v.filter((x) => x != null);
  if (v == null || v === '') return [];
  return [v];
}

/**
 * Build the full system+task prompt for a named agent.
 * Shared by human slash invocation and workflow engine.
 */
export function buildAgentPrompt(agent, ctx) {
  const body = loadPrompt(agent);
  const header = `You are the Lava agent "${agent.name}".
Role: ${agent.role || agent.name}
Repo root (main tree): ${ROOT}
Work ONLY within the assigned worktree when provided.
Hard rules (CLAUDE.md + docs/agent-system/ARCHITECTURE.md):
- ${FORBIDDEN.map((f) => 'Never: ' + f).join('\n- ')}
- Node is the oracle. Severity by class: parity/safety/security/gate-weakening never P2.
- PR only after successful pr-gate (SHIP or SHIP-AFTER).
`;

  const task = [];
  if (ctx.issue) {
    task.push(`GitHub issue #${ctx.issue.number}: ${ctx.issue.title}`);
    if (ctx.issue.body) task.push('Issue body:\n' + ctx.issue.body.slice(0, 8000));
  }
  if (ctx.wt) {
    task.push(`Worktree: ${ctx.wt}`);
    task.push(`Branch: ${ctx.branch || '(current)'}`);
    task.push(`LAVA_BIN=${ctx.env?.LAVA_BIN || join(ctx.wt, 'bin/lava')}`);
    task.push('Use make from this worktree directory only.');
  }
  if (ctx.plan) task.push(renderPlan(ctx.plan, ctx.planPath));
  else if (ctx.planPath) {
    task.push(
      `No plan yet. If you are planner, write the task DAG as JSON to ${ctx.planPath} ` +
        `(schema in the playbook below); later agents in this run read it from there.`,
    );
  }
  if (ctx.extra) task.push(ctx.extra);
  if (ctx.findingsPath) task.push(`Findings file: ${ctx.findingsPath}`);
  if (ctx.gateLog) task.push(`Gate log (tail):\n${String(ctx.gateLog).slice(-4000)}`);
  if (ctx.args?.length) task.push(`CLI args: ${ctx.args.join(' ')}`);
  // Mode flags the playbook documents (--design-only, --quick, --review-only …).
  // The command layer consumes the ones it knows and forwards the rest here;
  // before that they were parsed and dropped, so every documented mode was dead.
  const flags = Object.entries(ctx.flags || {});
  if (flags.length) {
    task.push(
      `Mode flags: ${flags.map(([k, v]) => (v === true ? `--${k}` : `--${k}=${v}`)).join(' ')}`,
    );
  }

  // The playbook is passed through verbatim. It used to be rewritten here by six
  // regexes that repaired paths left over from the previous layout — which meant
  // a system-invoked agent saw corrected paths while a human reading the same
  // file was sent to a script that no longer exists. The paths are fixed at the
  // source now, and `commands/prompt-paths.test.mjs` keeps them that way.
  return header + '\n## Task\n' + task.join('\n') + '\n\n## Agent playbook\n' + body;
}
