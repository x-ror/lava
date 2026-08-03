/**
 * Registry-sync gate.
 *
 * `config/agents.json` is what the runtime loads; `config/agents.yaml` is the
 * human-readable mirror. Two files hand-synced by convention drift — this one
 * already had `providers` parsed into a shape nothing matched — so the mirror is
 * held to the JSON by a test instead of by a comment asking nicely.
 *
 * Scope: the keys that SELECT BEHAVIOUR (which prompt an agent runs, whether it
 * isolates, whether it is the hard gate, which provider). `role` and `tools` are
 * prose and an unenforced hint respectively — a mirror that phrases a role
 * differently is not a bug, one that names a different prompt file is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadYamlFile } from './yaml.mjs';
import { ROOT, CONFIG_AGENTS } from './paths.mjs';
import { loadRegistry } from '../agents/registry.mjs';

const BEHAVIOUR_KEYS = [
  'command',
  'prompt',
  'provider',
  'isolation',
  'hard_gate',
  'design_first',
  'prefer_alt_provider',
];

test('mirror and registry agree on the agent set', () => {
  const yaml = loadYamlFile(CONFIG_AGENTS);
  const json = loadRegistry();
  assert.deepEqual(Object.keys(yaml.agents).sort(), Object.keys(json.agents).sort());
});

test('mirror and registry agree on every behaviour-selecting key', () => {
  const yaml = loadYamlFile(CONFIG_AGENTS);
  const json = loadRegistry();
  for (const [name, def] of Object.entries(json.agents)) {
    for (const key of BEHAVIOUR_KEYS) {
      assert.equal(
        yaml.agents[name]?.[key] ?? null,
        def[key] ?? null,
        `config/agents.yaml disagrees with config/agents.json on ${name}.${key}`,
      );
    }
  }
});

test('mirror and registry agree on commands, providers, defaults, dual_review', () => {
  const yaml = loadYamlFile(CONFIG_AGENTS);
  const json = loadRegistry();
  assert.deepEqual(yaml.commands, json.commands);
  assert.deepEqual(yaml.providers.sort(), Object.keys(json.providers).sort());
  for (const key of ['max_turns', 'max_fix_rounds', 'isolation', 'allow_merge']) {
    assert.equal(yaml.defaults?.[key] ?? null, json.defaults?.[key] ?? null, `defaults.${key}`);
  }
  for (const key of ['enabled', 'implement_provider', 'review_provider']) {
    assert.equal(
      yaml.dual_review?.[key] ?? null,
      json.dual_review?.[key] ?? null,
      `dual_review.${key}`,
    );
  }
});

test('every command resolves to a real agent or the pipeline', () => {
  const json = loadRegistry();
  for (const [cmd, target] of Object.entries(json.commands)) {
    assert.ok(
      target === 'pipeline' || json.agents[target] || json.specialists[target],
      `command ${cmd} → ${target} resolves to nothing`,
    );
  }
});

test('every prompt named by the registry exists on disk', () => {
  const json = loadRegistry();
  for (const group of ['agents', 'specialists']) {
    for (const [name, def] of Object.entries(json[group] || {})) {
      if (!def.prompt) continue;
      assert.ok(existsSync(join(ROOT, def.prompt)), `${group}.${name}: missing ${def.prompt}`);
    }
  }
});

test('merge stays off and isolation stays on in the shipped defaults', () => {
  // Not style: `allow_merge: true` would let the pipeline land on master, and
  // the whole design says merge is human. A config edit that flips either of
  // these should have to delete a test that says why.
  const json = loadRegistry();
  assert.equal(json.defaults.allow_merge, false);
  assert.equal(json.defaults.isolation, 'worktree');
  assert.equal(json.agents['pr-gate'].hard_gate, true);
});
