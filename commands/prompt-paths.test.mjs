/**
 * Prompt-tree integrity.
 *
 * `agents/prompts/` and `agents/specialists/` are canonical. The harness copies
 * (`.claude/agents/`, `.claude/skills/`, `.grok/skills/`) exist only because two
 * CLIs discover agents from their own directories — they are mirrors, and a
 * mirror nobody checks is a second source of truth waiting to happen.
 *
 * These duplicates were already drifting: three byte-identical copies of
 * `gates.md` all pointed at `scripts/agent-cycle/route-gates.mjs`, deleted in the
 * rewrite. `commands/build-prompt.mjs` repaired the path with a regex at send
 * time, so the SYSTEM saw a working command and a HUMAN opening the same file
 * did not. Fixing the source and deleting the regexes only holds if something
 * fails when a stale path or a re-added copy comes back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../runtime/paths.mjs';
import { loadRegistry, getAgent } from '../agents/registry.mjs';
import { buildAgentPrompt } from './build-prompt.mjs';

/** Paths that no longer exist and must not be named by any prompt or doc. */
const DEAD_PATHS = [
  'scripts/agent-cycle/',
  '.claude/skills/pr-gate/reference/',
  '.claude/skills/odin-feature/reference/',
  'docs/agent-cycle-plan.md',
];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

test('no prompt or specialist names a path that was deleted', () => {
  const files = [
    ...walk(join(ROOT, 'agents')),
    ...walk(join(ROOT, '.claude')),
    ...walk(join(ROOT, '.grok')),
  ];
  const bad = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const dead of DEAD_PATHS) {
      if (text.includes(dead)) bad.push(`${relative(ROOT, f)} → ${dead}`);
    }
  }
  assert.deepEqual(bad, [], `dead paths referenced:\n${bad.join('\n')}`);
});

test('the harness mirrors are byte-identical to the canonical specialists', () => {
  const canonical = join(ROOT, 'agents/specialists');
  for (const name of readdirSync(canonical)) {
    const mirror = join(ROOT, '.claude/agents', name);
    if (!existsSync(mirror)) continue;
    assert.equal(
      readFileSync(mirror, 'utf8'),
      readFileSync(join(canonical, name), 'utf8'),
      `.claude/agents/${name} has drifted from agents/specialists/${name}`,
    );
  }
});

test('the grok skill mirrors are byte-identical to the claude ones', () => {
  const base = join(ROOT, '.claude/skills');
  for (const name of readdirSync(base)) {
    const mirror = join(ROOT, '.grok/skills', name, 'SKILL.md');
    if (!existsSync(mirror)) continue;
    assert.equal(
      readFileSync(mirror, 'utf8'),
      readFileSync(join(base, name, 'SKILL.md'), 'utf8'),
      `.grok/skills/${name}/SKILL.md has drifted from .claude/skills/${name}/SKILL.md`,
    );
  }
});

test('reference docs live in exactly one place', () => {
  // A `reference/` tree under a skill is a copy of agents/prompts/*-reference/.
  // SKILL.md links to the canonical tree; a local copy is redundancy that drifts.
  for (const root of ['.claude/skills', '.grok/skills']) {
    for (const f of walk(join(ROOT, root))) {
      assert.ok(
        !relative(ROOT, f).includes('/reference/'),
        `${relative(ROOT, f)} duplicates a canonical reference doc`,
      );
    }
  }
});

test('every relative link in a playbook resolves', () => {
  const reg = loadRegistry();
  const missing = [];
  for (const def of Object.values(reg.agents)) {
    const dir = join(ROOT, def.prompt, '..');
    const text = readFileSync(join(ROOT, def.prompt), 'utf8');
    for (const m of text.matchAll(/\]\(([^)#:]+\.md)\)/g)) {
      const target = join(dir, m[1]);
      if (!existsSync(target)) missing.push(`${def.prompt} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `broken playbook links:\n${missing.join('\n')}`);
});

test('buildAgentPrompt passes the playbook through unmodified', () => {
  // No rewrite layer: what the agent is sent is what a human reads on disk.
  const agent = getAgent('pr-gate');
  const body = readFileSync(join(ROOT, agent.prompt), 'utf8');
  const prompt = buildAgentPrompt(agent, { issue: { number: 1, title: 't', body: '' } });
  assert.ok(prompt.endsWith(body), 'the playbook was altered on the way to the agent');
});
