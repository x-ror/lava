#!/usr/bin/env node
// Agent system — verdict aggregator — severity-only aggregator + SHIP / SHIP-AFTER / BLOCK.
// Encodes pr-gate scoring.md rules the autonomous cycle can apply without self-waive.
//
// Usage:
//   node runtime/gates/aggregate-verdict.mjs findings1.json [findings2.json ...]
//   echo '{...}' | node runtime/gates/aggregate-verdict.mjs --stdin
//
// Env:
//   MAX_P0=2          (default 2) — more than this with empty fix → BLOCK
//   GATE_RED=1        mechanical gate failed
//   GATE_UNRUN=1      required gate not executed

import { readFileSync } from 'node:fs';

const MAX_P0 = Number(process.env.MAX_P0 || 2);
const GATE_RED = process.env.GATE_RED === '1';
const GATE_UNRUN = process.env.GATE_UNRUN === '1' || process.env.GATE_PENDING === '1';

/**
 * Classes that must never be demoted to P2 (CLAUDE.md §1 / plan F3).
 *
 * Exported so `findings-schema.json` can be held to it: the schema left `class`
 * unconstrained and its description listed five of these, omitting
 * `memory-safety` — a class this set floors and no auditor reading the schema
 * would have known to use.
 */
export const FLOOR_CLASSES = new Set([
  'parity',
  'safety',
  'security',
  'gate-weakening',
  'memory-safety',
]);

/**
 * @param {object} f
 */
export function normalizeFinding(f) {
  const out = { ...f };
  if (
    out.class &&
    FLOOR_CLASSES.has(out.class) &&
    (out.severity === 'P2' || out.severity === 'nit')
  ) {
    out.severity = 'P1';
    out.severity_note = `raised from ${f.severity}: class ${out.class} cannot be P2`;
  }
  // Findings without file:line and without a concrete failure path are questions, not tasks.
  if (!out.file && !out.failure && !out.evidence) {
    out.discard = true;
    out.discard_reason = 'no file:line and no failure/evidence';
  }
  return out;
}

/**
 * @param {object[]} reports array of specialist reports
 * @param {{ gateRed?: boolean, gateUnrun?: boolean, maxP0?: number }} opts
 */
export function aggregate(reports, opts = {}) {
  const gateRed = opts.gateRed ?? GATE_RED;
  const gateUnrun = opts.gateUnrun ?? GATE_UNRUN;
  const maxP0 = opts.maxP0 ?? MAX_P0;

  // Hard stop: check/build failure → BLOCK, empty findings must not read as clean.
  if (gateRed) {
    return {
      verdict: 'BLOCK',
      reason: 'mechanical gate red (make check/build or routed gate failed)',
      p0: [],
      p1: [],
      p2: [],
      discarded: [],
      agents: reports.map((r) => r.agent),
    };
  }

  const p0 = [];
  const p1 = [];
  const p2 = [];
  const discarded = [];
  const seen = new Set();

  for (const report of reports) {
    for (const raw of report.findings || []) {
      const f = normalizeFinding({ ...raw, agent: report.agent });
      if (f.discard) {
        discarded.push(f);
        continue;
      }
      const key = `${f.file || ''}:${f.line || ''}:${f.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (f.severity === 'P0') p0.push(f);
      else if (f.severity === 'P1') p1.push(f);
      else p2.push(f);
    }
  }

  if (p0.some((f) => !f.fix || String(f.fix).trim() === '')) {
    return {
      verdict: 'BLOCK',
      reason: 'P0 with empty fix',
      p0,
      p1,
      p2,
      discarded,
    };
  }
  if (p0.length > maxP0) {
    return {
      verdict: 'BLOCK',
      reason: `P0 count ${p0.length} > MAX_P0 ${maxP0}`,
      p0,
      p1,
      p2,
      discarded,
    };
  }
  if (p0.length > 0) {
    return { verdict: 'SHIP-AFTER', reason: 'open P0', p0, p1, p2, discarded };
  }
  if (gateUnrun) {
    return {
      verdict: 'SHIP-AFTER',
      reason: 'required gate unrun or pending',
      p0,
      p1,
      p2,
      discarded,
    };
  }
  if (p1.length > 0) {
    return {
      verdict: 'SHIP-AFTER',
      reason: 'open P1 — cycle must not self-waive (human waiver only)',
      p0,
      p1,
      p2,
      discarded,
    };
  }
  return { verdict: 'SHIP', reason: 'no open P0/P1', p0, p1, p2, discarded };
}

function loadReports(args) {
  if (args[0] === '--stdin') {
    const raw = readFileSync(0, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [data];
  }
  return args.map((p) => JSON.parse(readFileSync(p, 'utf8')));
}

function main() {
  const reports = loadReports(process.argv.slice(2));
  const result = aggregate(reports);
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict === 'BLOCK') process.exit(2);
  if (result.verdict === 'SHIP-AFTER') process.exit(1);
  process.exit(0);
}

const isMain = process.argv[1] && process.argv[1].endsWith('aggregate-verdict.mjs');
if (isMain) main();
