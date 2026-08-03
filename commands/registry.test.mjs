import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgent, listAgents, loadPrompt, loadRegistry } from '../agents/registry.mjs';
import { parseSlashCommand } from '../workflows/triggers/pr-comments.mjs';
import { buildAgentPrompt } from './build-prompt.mjs';

test('registry lists required commands', () => {
  const L = listAgents();
  for (const c of ['odin-feature', 'pr-gate', 'planner', 'fixer', 'critic', 'run-pipeline']) {
    assert.ok(L.commands.includes(c), c);
  }
});

test('getAgent resolves odin-feature and pr-gate', () => {
  const a = getAgent('odin-feature');
  assert.equal(a.name, 'odin-feature');
  assert.equal(a.isolation, 'worktree');
  const g = getAgent('pr-gate');
  assert.equal(g.hard_gate, true);
});

test('getAgent pipeline is special', () => {
  const p = getAgent('run-pipeline');
  assert.equal(p.isPipeline, true);
});

test('prompts exist for core agents', () => {
  const reg = loadRegistry();
  for (const name of Object.keys(reg.agents)) {
    const agent = getAgent(name);
    const body = loadPrompt(agent);
    assert.ok(body.length > 50, name);
  }
});

test('buildAgentPrompt includes role and playbook', () => {
  const agent = getAgent('planner');
  const p = buildAgentPrompt(agent, { issue: { number: 1, title: 't', body: 'b' } });
  assert.match(p, /planner/);
  assert.match(p, /Task/);
});

test('parseSlashCommand recognizes commands', () => {
  assert.deepEqual(parseSlashCommand('/pr-gate'), { command: 'pr-gate', args: [] });
  assert.deepEqual(parseSlashCommand('/odin-feature --design-only'), {
    command: 'odin-feature',
    args: ['--design-only'],
  });
  assert.equal(parseSlashCommand('hello'), null);
  assert.equal(parseSlashCommand('/unknown-cmd'), null);
});
