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
  if (ctx.extra) task.push(ctx.extra);
  if (ctx.findingsPath) task.push(`Findings file: ${ctx.findingsPath}`);
  if (ctx.gateLog) task.push(`Gate log (tail):\n${String(ctx.gateLog).slice(-4000)}`);
  if (ctx.args?.length) task.push(`CLI args: ${ctx.args.join(' ')}`);

  let patched = body
    .replace(/\.\.\/pr-gate\/reference\//g, 'agents/prompts/pr-gate-reference/')
    .replace(
      /reference\/odin-sdk-map\.md/g,
      'agents/prompts/odin-feature-reference/odin-sdk-map.md',
    )
    .replace(/reference\/gates\.md/g, 'agents/prompts/pr-gate-reference/gates.md')
    .replace(/reference\/scoring\.md/g, 'agents/prompts/pr-gate-reference/scoring.md')
    .replace(/scripts\/agent-cycle\//g, 'runtime/gates/')
    .replace(/docs\/agent-cycle-plan\.md/g, 'docs/agent-system/ARCHITECTURE.md');

  return header + '\n## Task\n' + task.join('\n') + '\n\n## Agent playbook\n' + patched;
}
