/**
 * Trigger: PR / issue comments that name slash commands.
 *
 *   node workflows/triggers/pr-comments.mjs --pr 42
 *   node workflows/triggers/pr-comments.mjs --comment-body '/pr-gate'
 *
 * Parses the first slash command and routes through the Command Layer.
 */
import { invokeCommand } from '../../commands/invoke.mjs';
import { gh } from '../../runtime/github.mjs';

const COMMANDS = new Set(['odin-feature', 'pr-gate', 'planner', 'fixer', 'critic', 'run-pipeline']);

/**
 * @param {string} body
 * @returns {{ command: string, args: string[] } | null}
 */
export function parseSlashCommand(body) {
  if (!body) return null;
  const m = body.match(/^\s*\/([a-z0-9-]+)(?:\s+(.*))?$/im);
  if (!m) return null;
  const command = m[1];
  if (!COMMANDS.has(command)) return null;
  const args = (m[2] || '').trim().split(/\s+/).filter(Boolean);
  return { command, args };
}

/**
 * Body of the most recent comment on an issue or PR.
 *
 * `gh api --jq '.body'` prints the STRING, unquoted — it is not JSON, so the
 * JSON-decoding helper threw on every ordinary comment and the `--pr` path
 * never worked. Raw text, trailing newline removed.
 *
 * @param {number|string} number issue or PR number
 * @param {{ gh?: Function }} [deps]
 */
export function latestCommentBody(number, deps = {}) {
  const run = deps.gh || gh;
  const out = run(['api', `repos/{owner}/{repo}/issues/${number}/comments`, '--jq', '.[-1].body']);
  return String(out).replace(/\n$/, '');
}

export async function handleComment({ body, pr, issue, provider }) {
  const parsed = parseSlashCommand(body);
  if (!parsed) {
    return { ok: false, reason: 'no recognized slash command' };
  }
  const issueNum = issue || pr;
  return invokeCommand(parsed.command, {
    args: parsed.args,
    issue: issueNum ? Number(issueNum) : undefined,
    provider: provider || process.env.AGENT_PROVIDER || 'auto',
    source: 'trigger',
    worktree: parsed.command !== 'planner',
  });
}

async function main() {
  const args = process.argv.slice(2);
  let body = null;
  let pr = null;
  let issue = null;
  let provider;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--comment-body') body = args[++i];
    else if (args[i] === '--pr') pr = args[++i];
    else if (args[i] === '--issue') issue = args[++i];
    else if (args[i] === '--provider') provider = args[++i];
  }
  if (!body && pr) body = latestCommentBody(pr);
  if (!body) {
    console.error('usage: pr-comments.mjs --comment-body "/pr-gate" [--pr N]');
    process.exit(2);
  }
  const r = await handleComment({ body, pr, issue, provider });
  console.log(JSON.stringify(r, null, 2));
}

const isMain = process.argv[1] && process.argv[1].endsWith('pr-comments.mjs');
if (isMain)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
