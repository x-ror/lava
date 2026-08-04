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
  // An object with `.run` is used as-is. The seam exists so the timing contract
  // can be tested against a provider that reports its own durationMs; no real
  // provider does today, which is exactly why the spread order went unnoticed.
  if (name && typeof name === 'object' && typeof name.run === 'function') return name;
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
/**
 * An agent turn that ends faster than this did not happen.
 *
 * A real session is minutes: read the tree, run gates, decide. A CLI refusing to
 * start — bad credentials, a usage limit, a missing binary — returns in under a
 * second. Measured on the failure that motivated this: three fixer rounds at
 * 2-3s each, from a claude CLI that exited 1 without doing a turn, which burned
 * the whole fix budget and closed the run as needs-human. Ten seconds is far
 * above any startup and far below any real turn, so it does not need to be
 * exact to separate the two.
 */
export const PROVIDER_MIN_TURN_MS = 10_000;

/**
 * @param {{status: number|null, skipped?: boolean, durationMs?: number}} result
 * @returns {boolean} the provider never performed a turn, so nothing was tried
 */
export function providerDidNotRun(result) {
  if (result.skipped) return true;
  if (result.status === 0) return false;
  return (result.durationMs ?? Infinity) < PROVIDER_MIN_TURN_MS;
}

export function runLlm(prompt, ctx) {
  const provider = resolveProvider(ctx.provider || process.env.AGENT_PROVIDER || 'auto', {
    prefer: ctx.prefer,
    avoid: ctx.avoid,
  });
  // Timed here rather than in each provider: one clock, and a provider that
  // forgets to report leaves `durationMs` correct instead of missing.
  const started = Date.now();
  const result = provider.run(prompt, ctx);
  // Spread FIRST so the measurement wins. The other order let a provider's own
  // `durationMs` overwrite the wrapper's — which is exactly what the comment
  // above claims cannot happen, and would feed providerDidNotRun a number the
  // provider chose rather than the elapsed time.
  return { ...result, durationMs: Date.now() - started };
}

export function listProviders() {
  return Object.keys(PROVIDERS).map((k) => ({
    name: k,
    available: k === 'none' ? true : commandExists(k),
  }));
}
