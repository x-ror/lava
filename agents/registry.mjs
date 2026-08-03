/**
 * Agent Registry — loads config/agents.json and resolves named commands
 * to agent definitions (role, prompt, tools, provider, retry policy).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../runtime/paths.mjs';

const CONFIG_PATH = join(ROOT, 'config/agents.json');

let _cache = null;

export function loadRegistry() {
  if (_cache) return _cache;
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`missing agent registry: ${CONFIG_PATH}`);
  }
  _cache = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return _cache;
}

export function resetRegistryCache() {
  _cache = null;
}

/** @param {string} name command or agent name */
export function getAgent(name) {
  const reg = loadRegistry();
  const mapped = reg.commands?.[name] || name;
  if (mapped === 'pipeline') {
    return {
      name: 'pipeline',
      role: 'Run the full autonomous feature pipeline DAG',
      command: 'run-pipeline',
      isPipeline: true,
    };
  }
  const def = reg.agents?.[mapped];
  if (!def) {
    const sp = reg.specialists?.[mapped];
    if (sp) {
      return {
        name: mapped,
        role: `Specialist: ${mapped}`,
        command: mapped,
        prompt: sp.prompt,
        provider: sp.provider || 'auto',
        specialist: true,
      };
    }
    throw new Error(`unknown agent/command: ${name}`);
  }
  return {
    name: mapped,
    ...def,
    defaults: reg.defaults,
    dual_review: reg.dual_review,
  };
}

export function listAgents() {
  const reg = loadRegistry();
  return {
    commands: Object.keys(reg.commands || {}),
    agents: Object.keys(reg.agents || {}),
    specialists: Object.keys(reg.specialists || {}),
    providers: Object.keys(reg.providers || {}),
  };
}

export function loadPrompt(agent) {
  if (!agent.prompt) return '';
  const path = join(ROOT, agent.prompt);
  if (!existsSync(path)) {
    throw new Error(`prompt file missing for ${agent.name}: ${path}`);
  }
  return readFileSync(path, 'utf8');
}
