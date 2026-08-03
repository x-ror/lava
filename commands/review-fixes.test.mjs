/**
 * Findings from the PR review on #342, each pinned where it actually lives.
 *
 * Three of these were defects in code added the day before, and one of those
 * had a comment describing a guard the code did not contain — the retry claimed
 * to fire only on "an exit with no signal" and never looked at `r.signal`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPlan } from './build-prompt.mjs';
import { invokeCommand, invocationOk } from './invoke.mjs';
import { shouldRetryOnStdin } from '../llm/providers/claude.mjs';
import { latestCommentBody } from '../workflows/triggers/pr-comments.mjs';
import { shouldDispatch } from '../workflows/triggers/issues.mjs';

// ── #6 renderPlan on a plan an LLM wrote ────────────────────────────────────

test('a scalar where the schema says array does not crash the invocation', () => {
  // JSON.parse accepts {"depends_on": "t1"}; a string has .length, so the old
  // truthiness check passed and .join threw. The contract elsewhere is that a
  // malformed plan is context, not a gate.
  const out = renderPlan({ tasks: [{ id: 't1', title: 'x', depends_on: 't0' }] });
  assert.match(out, /t1: x after t0/);
});

test('scalar acceptance and paths_hint render too', () => {
  const out = renderPlan({
    tasks: [{ id: 't1', title: 'x', acceptance: 'it works', paths_hint: 'pkg/a.odin' }],
  });
  assert.match(out, /accept: it works/);
  assert.match(out, /paths: pkg\/a\.odin/);
});

test('null and non-object tasks do not crash', () => {
  assert.doesNotThrow(() => renderPlan({ tasks: [null, 3, {}] }));
  assert.doesNotThrow(() => renderPlan({ tasks: 'not a list' }));
});

// ── #9 claude retry ─────────────────────────────────────────────────────────

test('a spawn failure is retried', () => {
  assert.equal(
    shouldRetryOnStdin({ error: new Error('ENOENT'), status: null, signal: null }),
    true,
  );
});

test('a process killed by a signal is NOT retried', () => {
  // spawnSync reports status null for a signal death too. The agent may already
  // have edited the worktree and spent its budget; a rerun is neither free nor
  // idempotent.
  assert.equal(shouldRetryOnStdin({ status: null, signal: 'SIGKILL' }), false);
  assert.equal(shouldRetryOnStdin({ status: null, signal: 'SIGTERM' }), false);
});

test('a plain non-zero exit is NOT retried', () => {
  assert.equal(shouldRetryOnStdin({ status: 1, signal: null }), false);
});

// ── #5 comment body is raw text, not JSON ───────────────────────────────────

test('an ordinary comment body survives the fetch', () => {
  // `gh api --jq '.body'` prints the string unquoted. Decoding it as JSON threw
  // on every normal comment, so the --pr path never worked.
  const body = latestCommentBody(42, { gh: () => '/pr-gate please\n' });
  assert.equal(body, '/pr-gate please');
});

test('a body that happens to look like JSON is still returned verbatim', () => {
  assert.equal(latestCommentBody(42, { gh: () => '{"not":"parsed"}\n' }), '{"not":"parsed"}');
});

// ── #11 concurrency guard ───────────────────────────────────────────────────

const T0 = Date.parse('2026-08-03T10:00:00Z');

test('an issue with a run in flight is not dispatched again', () => {
  const rec = { status: 'running', attempts: 1, ts: new Date(T0).toISOString(), updatedAt: 'T1' };
  const d = shouldDispatch({ number: 1, updatedAt: 'T1' }, rec, T0 + 60_000);
  assert.equal(d.dispatch, false);
  assert.match(d.reason, /already running/);
});

test('a run in flight is not restarted by the issue being touched', () => {
  // The agent's own label or comment changes updatedAt. Before the guard moved
  // ahead of that check, the trigger restarted the issue it was working on.
  const rec = { status: 'running', attempts: 1, ts: new Date(T0).toISOString(), updatedAt: 'T1' };
  assert.equal(shouldDispatch({ number: 1, updatedAt: 'T2' }, rec, T0 + 60_000).dispatch, false);
});

test('a run whose lease expired is presumed dead and retried', () => {
  const rec = { status: 'running', attempts: 1, ts: new Date(T0).toISOString(), updatedAt: 'T1' };
  const d = shouldDispatch({ number: 1, updatedAt: 'T1' }, rec, T0 + 7 * 60 * 60 * 1000);
  assert.equal(d.dispatch, true);
  assert.match(d.reason, /retry/);
});

test('a running record with no timestamp is recoverable, not a permanent wedge', () => {
  const rec = { status: 'running', attempts: 1, updatedAt: 'T1' };
  assert.equal(shouldDispatch({ number: 1, updatedAt: 'T1' }, rec, T0).dispatch, true);
});

// ── #2/#3 a blocked hard gate is not a success ──────────────────────────────

test('a hard gate with no findings reports failure, end to end', async () => {
  // `ok` for a hard gate means the gate PASSED. The CLI exit code, the
  // gate-failure trigger and the comment handler all read `ok` and nothing else.
  const dir = mkdtempSync(join(tmpdir(), 'lava-gate-'));
  try {
    // Written before the run and deleted by it: a stale verdict must not be
    // mistaken for this round's, which is also why no stub can plant one.
    writeFileSync(join(dir, '.agent-findings.json'), JSON.stringify({ agent: 'x', findings: [] }));
    const r = await invokeCommand('pr-gate', {
      issue: { number: 1, title: 't', body: '' },
      cwd: dir,
      provider: 'none',
      worktree: false,
      source: 'human',
    });
    assert.equal(r.verdict, null, 'the stale findings file was read as a verdict');
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the verdict, not the exit code, decides a hard gate', () => {
  // Driving this through invokeCommand is not possible on purpose: a hard gate
  // deletes any stale findings file before running, so no stub provider can
  // leave one behind. The rule itself is what matters, so it is a function.
  const gate = { hard_gate: true };
  const exited0 = { status: 0 };
  assert.equal(invocationOk(gate, { verdict: 'SHIP' }, exited0), true);
  assert.equal(invocationOk(gate, { verdict: 'SHIP-AFTER' }, exited0), true);
  assert.equal(invocationOk(gate, { verdict: 'BLOCK' }, exited0), false);
  assert.equal(invocationOk(gate, null, exited0), false);
});

test('a hard gate that was skipped by provider `none` is not a pass', () => {
  assert.equal(invocationOk({ hard_gate: true }, null, { status: 0, skipped: true }), false);
});

test('a non-gate agent still goes by its exit code', () => {
  assert.equal(invocationOk({}, null, { status: 0 }), true);
  assert.equal(invocationOk({}, null, { status: 1 }), false);
  assert.equal(invocationOk({}, null, { status: 0, skipped: true }), true);
  assert.equal(invocationOk({}, { verdict: 'BLOCK' }, { status: 0 }), true);
});

test('a non-gate agent is unaffected by the verdict rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lava-gate-'));
  try {
    const r = await invokeCommand('critic', {
      issue: { number: 1, title: 't', body: '' },
      cwd: dir,
      provider: 'none',
      worktree: false,
      source: 'human',
    });
    assert.equal(r.ok, true, 'only hard gates gate on a verdict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #1 command-specific flags reach the agent ───────────────────────────────

test('mode flags the playbook documents reach the prompt', async () => {
  // --design-only, --quick, --review-only and friends were parsed by the CLI
  // and then dropped, so every mode the SKILL.md argument-hints advertise was
  // documented and dead.
  const { buildAgentPrompt } = await import('./build-prompt.mjs');
  const { getAgent } = await import('../agents/registry.mjs');
  const p = buildAgentPrompt(getAgent('odin-feature'), {
    issue: { number: 1, title: 't', body: '' },
    flags: { 'design-only': true, scout: 'deep' },
  });
  assert.match(p, /Mode flags: --design-only --scout=deep/);
});

test('no flags means no noise in the prompt', () => {
  assert.doesNotMatch(renderPlan({ tasks: [] }), /Mode flags/);
});

// ── permission comes from the label, never from an issue body ───────────────

test('a lava-task marker in an untrusted body is not permission to run', async () => {
  // Drives discoverTriggeredIssues itself. The first version of this asserted on
  // isAgentReady — which the mutation does not touch — so the manifest entry it
  // backed reported SURVIVED: the gate passed with the filter fully broken.
  const { discoverTriggeredIssues } = await import('../workflows/triggers/issues.mjs');
  const picked = discoverTriggeredIssues([
    { number: 1, labels: [], body: '<!-- lava-task\npriority: P0\n-->' },
    { number: 2, labels: [{ name: 'agent-ready' }], body: '' },
    { number: 3, labels: [{ name: 'lava-ready' }], body: '' },
    { number: 4, labels: [{ name: 'bug' }], body: 'please run /odin-feature' },
  ]);
  assert.deepEqual(
    picked.map((i) => i.number),
    [2, 3],
    'an issue body granted itself a run',
  );
});

test('the permission label is what admits an issue, on its own', async () => {
  const { isAgentReady } = await import('../runtime/github.mjs');
  assert.equal(isAgentReady({ labels: [], body: '<!-- lava-task -->' }), false);
  assert.equal(isAgentReady({ labels: [{ name: 'agent-ready' }] }), true);
});

// ── the hard gate must be told where to put its verdict ─────────────────────

test('a hard gate is told the exact path to write its verdict to', async () => {
  // pr-gate exited 0 and wrote nothing, so every run ended BLOCK — "produced no
  // verdict" — and the pipeline could not reach a PR at all. The playbook asked
  // for a text report and never named .agent-findings.json.
  const { buildAgentPrompt } = await import('./build-prompt.mjs');
  const { getAgent } = await import('../agents/registry.mjs');
  const p = buildAgentPrompt(getAgent('pr-gate'), {
    issue: { number: 1, title: 't', body: '' },
    wt: '/wt',
    findingsPath: '/wt/.agent-findings.json',
  });
  assert.match(p, /\/wt\/\.agent-findings\.json/);
  assert.match(p, /severity/, 'the shape the aggregator reads is not described');
});

test('invokeCommand hands a hard gate its findings path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lava-fp-'));
  try {
    await invokeCommand('pr-gate', {
      issue: { number: 1, title: 't', body: '' },
      cwd: dir,
      provider: 'none',
      worktree: false,
      source: 'human',
    });
    const prompt = readFileSync(join(dir, '.agent-prompt.txt'), 'utf8');
    // The ABSOLUTE path, which only the injection can produce. Matching on
    // ".agent-findings.json" alone passed without the injection, because the
    // playbook now names the file too — the assertion was satisfied by the
    // very text it was supposed to be independent of.
    assert.match(
      prompt,
      new RegExp(`Verdict file \\(REQUIRED\\): ${dir}/\\.agent-findings\\.json`),
      'the agent was never told which worktree to write into',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-gate agent is not asked for a verdict file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lava-fp-'));
  try {
    await invokeCommand('critic', {
      issue: { number: 1, title: 't', body: '' },
      cwd: dir,
      provider: 'none',
      worktree: false,
      source: 'human',
    });
    const prompt = readFileSync(join(dir, '.agent-prompt.txt'), 'utf8');
    assert.doesNotMatch(prompt, /\.agent-findings\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the verdict example in the playbook is not fiction', async () => {
  // A documented shape nobody executes drifts from the schema and from the
  // aggregator that consumes it. This runs the example through both.
  const { ROOT } = await import('../runtime/paths.mjs');
  const { aggregate } = await import('../runtime/gates/aggregate-verdict.mjs');
  const md = readFileSync(join(ROOT, 'agents/prompts/pr-gate.md'), 'utf8');
  const block = md.match(/## Step 5b[\s\S]*?```json\n([\s\S]*?)```/);
  assert.ok(block, 'the playbook no longer documents the verdict file');
  const doc = JSON.parse(block[1]);

  const schema = JSON.parse(readFileSync(join(ROOT, 'runtime/gates/findings-schema.json'), 'utf8'));
  for (const k of schema.required) assert.ok(k in doc, `example lacks ${k}`);
  const itemSchema = schema.properties.findings.items;
  for (const f of doc.findings) {
    for (const k of itemSchema.required) assert.ok(k in f, `finding lacks ${k}`);
    assert.ok(itemSchema.properties.severity.enum.includes(f.severity));
    assert.ok(itemSchema.properties.confidence.enum.includes(f.confidence));
  }

  // A P0 that carries a fix is the autonomous ceiling, not a block.
  assert.equal(aggregate([doc]).verdict, 'SHIP-AFTER');
  assert.equal(aggregate([{ agent: 'pr-gate', findings: [] }]).verdict, 'SHIP');
});
