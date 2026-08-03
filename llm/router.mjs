/**
 * LLM Router — resolves Claude / Grok / Codex / none for each agent.
 * Supports dual-review: implementer on provider A, critic/pr-gate on provider B.
 */
import { commandExists } from '../runtime/shell.mjs';
import * as none from './providers/none.mjs';
import * as grok from './providers/grok.mjs';
import * as claude from './providers/claude.mjs';
import * as codex from './providers/codex.mjs';

const PROVIDERS = { none, grok, claude, codex };

/**
 * @param {string} name auto|grok|claude|codex|none
 * @param {{ prefer?: string, avoid?: string }} [opts]
 */
export function resolveProvider(name = 'auto', opts = {}) {
  const order = ['grok', 'claude', 'codex'];
  if (name && name !== 'auto') {
    if (!PROVIDERS[name]) throw new Error(`unknown provider: ${name}`);
    if (name === 'none') return PROVIDERS.none;
    if (!commandExists(name)) {
      console.warn(`[llm] ${name} not on PATH — falling back to none`);
      return PROVIDERS.none;
    }
    return PROVIDERS[name];
  }
  const candidates = [];
  if (opts.prefer && PROVIDERS[opts.prefer]) candidates.push(opts.prefer);
  for (const p of order) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const p of candidates) {
    if (opts.avoid && p === opts.avoid) continue;
    if (commandExists(p)) return PROVIDERS[p];
  }
  return PROVIDERS.none;
}

/**
 * @param {string} prompt
 * @param {{ cwd: string, maxTurns?: number, env?: object, provider?: string, avoid?: string, prefer?: string }} ctx
 */
export function runLlm(prompt, ctx) {
  const provider = resolveProvider(ctx.provider || process.env.AGENT_PROVIDER || 'auto', {
    prefer: ctx.prefer,
    avoid: ctx.avoid,
  });
  return provider.run(prompt, ctx);
}

export function listProviders() {
  return Object.keys(PROVIDERS).map((k) => ({
    name: k,
    available: k === 'none' ? true : commandExists(k),
  }));
}
