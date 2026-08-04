/** Run routed mechanical gates in a worktree. */
import { sh } from '../shell.mjs';
import { changedFiles } from '../worktree.mjs';
import { routePaths } from './route-gates.mjs';

/**
 * Gate failures the pipeline may clear ITSELF, deterministically.
 *
 * Not a permission handed to an agent. The pollution ratchet reports an
 * IMPROVEMENT as a failure — it wants the tighter baseline committed — and the
 * baseline is a human-only path, so `fixer` cannot clear it no matter how long
 * it works. #91 hit exactly that: the agent hardened `internal/sqlite.js` by two
 * sites, the ratchet said "commit the tighter baseline", and the fix loop spent
 * rounds on something the hook forbids it to touch.
 *
 * The recovery is safe because the ratchet itself draws the line:
 *   - counts UP        → "Pollution ratchet FAILED"  → excluded here
 *   - stale entries    → also FAILED (a deleted file is a failure, not a prune)
 *   - `--update` alone → refuses to RAISE without --allow-raise
 * So "improved and not failed" can only lower existing entries, which is the
 * one direction CLAUDE.md §5 permits without a written reason.
 *
 * The decision is made from the tool's own output by code, never by a model.
 */
const RECOVERIES = [
  {
    id: 'primordials-improved',
    detect: (log) => log.includes('Ratchet improved') && !log.includes('Pollution ratchet FAILED'),
    command: 'node scripts/check-primordials.mjs --update',
    why: 'the ratchet asked for the tighter baseline, and only a human may write it',
  },
];

/**
 * @param {string} log combined output of the failed target
 * @returns {{id: string, command: string, why: string} | null}
 */
export function findRecovery(log) {
  return RECOVERIES.find((r) => r.detect(log || '')) || null;
}

/**
 * Failures whose ONLY correct fix is a human-only path.
 *
 * Handing these to `fixer` wastes its budget and then lies about the outcome:
 * the run ends "fixer ran 3 times without clearing the gate" when the truth is
 * that the hook forbids it to touch the file at all.
 *
 * Deliberately just two. Most gate failures look protected and are not, and
 * over-classifying stops runs the fixer could have finished:
 *   - a bench cap EXCEEDED → make it faster; loosening the cap is not the fix
 *   - a case-count floor   → add cases; lowering the floor is not the fix
 *   - a mutation surviving → fix the test; rewriting the manifest is not the fix
 * In each of those the agent-writable answer is the right one. Only these two
 * have no such answer.
 */
const HUMAN_ONLY = [
  {
    id: 'primordials-raise',
    detect: (log) => log.includes('Refusing to RAISE the baseline'),
    path: 'tests/node-compat/pollution-baseline.json',
    reason:
      'the ratchet would have to RAISE, which needs --allow-raise and a written reason ' +
      '(CLAUDE.md §5) — a deliberate human decision, not a fix',
  },
  {
    id: 'bench-uncapped',
    detect: (log) => log.includes('benches without a cap or report_only opt-out'),
    path: 'bench/thresholds.json',
    reason: 'a new bench needs a cap or a report_only opt-out, and that file is human-only',
  },
];

/**
 * @param {string} log combined output of the failed target
 * @returns {{id: string, path: string, reason: string} | null}
 */
export function findHumanOnly(log) {
  return HUMAN_ONLY.find((h) => h.detect(log || '')) || null;
}

/**
 * The result a failed target produces, classification included.
 *
 * Extracted so the WIRING is testable and not just the predicate: a version
 * that classified correctly and forgot to attach the answer passed every
 * predicate test, because those never went through runGates. runGates itself
 * shells out to `make`, so this is the seam.
 *
 * @param {string} target the make target that failed
 * @param {string} out its combined stdout+stderr
 * @param {{logs: string[], files: string[], targets: string[]}} ctx
 */
export function failedGate(target, out, ctx) {
  const humanOnly = findHumanOnly(out);
  const logs = [...ctx.logs];
  if (humanOnly) logs.push(`human-only: ${humanOnly.id} — ${humanOnly.reason}`);
  return {
    ok: false,
    log: logs.join('\n'),
    files: ctx.files,
    targets: ctx.targets,
    failed: target,
    humanOnly,
  };
}

/**
 * Run the routed mechanical gates in a worktree.
 *
 * @param {string} wt
 * @param {object} env
 * @param {{ runMutation?: boolean }} [opts]
 *   runMutation defaults to FALSE: `make test-mutation` re-applies every entry in
 *   the manifest and is minutes of work, too slow for the fix→verify loop. The
 *   final pre-PR gate passes true — skipping it there would be gate-weakening
 *   (CLAUDE.md §6), which is exactly what the previous `skipMutation !== false`
 *   spelling did: no caller passed the flag, so mutation never ran at all.
 * @returns {{ ok: boolean, log: string, files: string[], targets: string[], failed?: string }}
 */
export function runGates(wt, env, opts = {}) {
  const files = changedFiles(wt);
  if (!files.length) {
    const r = sh('make check', { cwd: wt, env, timeout: 600_000 });
    return {
      ok: r.status === 0,
      log: (r.stdout || '') + (r.stderr || ''),
      files,
      targets: ['make check'],
    };
  }
  const routed = routePaths(files);
  const logs = [];
  // Once each per run: a recovery that did not clear the gate must not be
  // retried into a loop.
  const attempted = new Set();
  let r = sh('make build', { cwd: wt, env, timeout: 600_000 });
  logs.push(`make build → ${r.status}\n${r.stderr || ''}`);
  if (r.status !== 0) {
    return {
      ok: false,
      log: logs.join('\n'),
      files,
      targets: routed.targets,
      failed: 'make build',
    };
  }
  for (const t of routed.targets) {
    if (t === 'make build') continue;
    if (t === 'make test-mutation' && !opts.runMutation) {
      logs.push('skip test-mutation (tight loop; the pre-PR gate runs it)');
      continue;
    }
    r = sh(t, { cwd: wt, env, timeout: 1_800_000 });
    logs.push(`${t} → ${r.status}\n${(r.stderr || '').slice(0, 2000)}`);

    if (r.status !== 0) {
      // One recovery attempt, then the target must pass on its own merits.
      const recovery = findRecovery((r.stdout || '') + (r.stderr || ''));
      if (recovery && !attempted.has(recovery.id)) {
        attempted.add(recovery.id);
        logs.push(`recovery ${recovery.id}: ${recovery.why}\n  ${recovery.command}`);
        const fix = sh(recovery.command, { cwd: wt, env, timeout: 600_000 });
        logs.push(`  → ${fix.status}\n${(fix.stderr || '').slice(0, 500)}`);
        if (fix.status === 0) {
          r = sh(t, { cwd: wt, env, timeout: 1_800_000 });
          logs.push(`${t} (after ${recovery.id}) → ${r.status}`);
        }
      }
    }

    if (r.status !== 0) {
      return failedGate(t, (r.stdout || '') + (r.stderr || ''), {
        logs,
        files,
        targets: routed.targets,
      });
    }
  }
  return { ok: true, log: logs.join('\n'), files, targets: routed.targets };
}
