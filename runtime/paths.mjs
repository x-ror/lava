/** Repo root and agent-system path constants. */
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = join(ROOT, '.agent-state');
export const CONFIG_AGENTS = join(ROOT, 'config/agents.yaml');
export const CONFIG_PIPELINE = join(ROOT, 'config/pipeline.yaml');
export const WORKTREE_BOOTSTRAP = join(ROOT, 'runtime/worktree-bootstrap.sh');
/** Written by a hard-gate agent, read back by commands/invoke.mjs. */
export const FINDINGS_FILE = '.agent-findings.json';
/** Written by planner, read back and forwarded to every later agent. */
export const PLAN_FILE = '.agent-plan.json';
