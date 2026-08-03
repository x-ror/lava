#!/usr/bin/env node
/**
 * Command Layer CLI — single entry for humans and automation.
 *
 *   node commands/index.mjs <command> [args...]
 *   node commands/index.mjs list
 *   node commands/index.mjs run-pipeline --once --provider grok
 *   node commands/index.mjs odin-feature --issue 335 --provider grok
 *   node commands/index.mjs pr-gate --issue 335 --cwd /path/to/wt
 *
 * Slash commands (/odin-feature, /pr-gate, …) are thin wrappers that land here.
 * The workflow engine calls invokeCommand() with source: 'workflow'.
 */
import { invokeCommand } from './invoke.mjs';
import { listAgents, getAgent } from '../agents/registry.mjs';
import { listProviders } from '../llm/router.mjs';

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * Flags this layer consumes. Anything else belongs to the invoked command —
 * --design-only, --quick, --review-only and the rest that the SKILL.md
 * argument-hints advertise. parseArgs swallowed every `--` token and main
 * forwarded only the fixed fields, so those documented modes were dead on
 * arrival: the flag was parsed, then dropped before the prompt was built.
 */
const KNOWN_FLAGS = new Set([
  'issue',
  'provider',
  'agent',
  'max-turns',
  'cwd',
  'worktree',
  'no-worktree',
  'dry-run',
  'source',
  'once',
  'max',
  'issues',
  'no-pr',
]);

function printHelp() {
  console.log(`Lava agent commands — human + autonomous entrypoint

Usage:
  node commands/index.mjs list
  node commands/index.mjs providers
  node commands/index.mjs <command> [options]

Commands (also slash-invokable as /<command>):
  odin-feature   Implement a feature (TDD)
  pr-gate        Hard review + tests gate (required before PR)
  planner        Build task DAG from issues
  critic         Adversarial critique before pr-gate
  fixer          Fix from gate/review findings
  run-pipeline   Full autonomous DAG: planner→odin-feature→critic→pr-gate→PR

Options:
  --issue N          GitHub issue number
  --provider NAME    grok | claude | codex | none | auto
  --cwd PATH         Working directory / existing worktree
  --worktree         Force isolated worktree (default for system invokes)
  --no-worktree      Stay in cwd; for run-pipeline this also forces --no-pr
  --dry-run          Write prompt only
  --max-turns N      Headless turn budget
  --once / --max N   Pipeline drain limits
  --issues a,b,c     Pipeline explicit queue
  --no-pr            Pipeline: do not open draft PR
  --source NAME      human | workflow | trigger (default human)

Examples:
  node commands/index.mjs run-pipeline --once --provider grok
  node commands/index.mjs odin-feature --issue 335 --provider grok --worktree
  node commands/index.mjs pr-gate --cwd ../lava-wt-agent-335-12345
`);
}

async function main() {
  const raw = process.argv.slice(2);
  if (!raw.length || raw[0] === '-h' || raw[0] === '--help' || raw[0] === 'help') {
    printHelp();
    process.exit(0);
  }
  const { _: args, flags } = parseArgs(raw);
  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === 'list') {
    console.log(JSON.stringify(listAgents(), null, 2));
    return;
  }
  if (cmd === 'providers') {
    console.log(JSON.stringify(listProviders(), null, 2));
    return;
  }

  try {
    getAgent(cmd);
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exit(2);
  }

  const opts = {
    args: rest,
    issue: flags.issue ? Number(flags.issue) : undefined,
    provider: flags.provider || flags.agent || undefined,
    maxTurns: flags['max-turns'] ? Number(flags['max-turns']) : undefined,
    cwd: flags.cwd || undefined,
    worktree: flags.worktree ? true : flags['no-worktree'] ? false : undefined,
    dryRun: !!flags['dry-run'],
    source: flags.source || 'human',
    once: !!flags.once,
    max: flags.max ? Number(flags.max) : undefined,
    issues: flags.issues
      ? String(flags.issues)
          .split(',')
          .map((s) => Number(s.trim()))
      : undefined,
    createPr: flags['no-pr'] ? false : true,
    flags: Object.fromEntries(Object.entries(flags).filter(([k]) => !KNOWN_FLAGS.has(k))),
  };

  const result = await invokeCommand(cmd, opts);
  console.log(JSON.stringify(result, null, 2));
  if (result && result.ok === false) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
