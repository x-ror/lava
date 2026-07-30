// Baseline comparison for the pollution ratchet — the DECISION layer, pulled out
// of the CLI so it can be tested.
//
// It was inline in check-primordials.mjs, which no test imports, and four
// mutations were demonstrated to survive the whole suite: collapsing the
// per-class loop into one total (so a file could trade a fixed accessor for a new
// live global and still pass), treating a file absent from the baseline as
// permissive (so a brand-new unhardened module lands silently), inverting the
// refuse-to-raise condition (so `--update` quietly raises every floor), and
// deleting the self-test gate (so a blinded detector rebaselines to all zeros).
// Pure functions here, assertions in check-primordials.baseline.test.mjs.

import { KINDS } from './primordials-detect.mjs';

// compare answers three questions at once, per file per CLASS:
//   failures     — a class went UP; the ratchet's whole job
//   improvements — a class went DOWN; the caller must commit the tighter floor
//   stale        — the baseline names a file that no longer exists
//
// `stale` is not cosmetic. Nothing pruned those entries, and the compare loop
// only ever walked the CURRENT files, so a deleted-then-readded path inherited
// its old ceiling: re-adding a file at 5 sites against a stale 99 was reported as
// "hardened by 94" instead of as new unhardened ground. Renaming every key (which
// happened when the scan root widened) is exactly how stale entries arrive.
export function compare(counts, baseline) {
  const failures = [];
  const improvements = [];
  for (const key of Object.keys(counts)) {
    for (const kind of KINDS) {
      const now = counts[key][kind];
      // A file with no baseline entry starts at 0 in every class — an unhardened
      // new module cannot land silently.
      const base = baseline[key]?.[kind] ?? 0;
      if (now > base) failures.push({ key, kind, now, base });
      else if (now < base) improvements.push({ key, kind, now, base });
    }
  }
  const stale = Object.keys(baseline).filter((key) => !(key in counts));
  return { failures, improvements, stale };
}

// Which entries `--update` would move UP. The ratchet only moves down, so a raise
// needs an explicit flag and a reason (a newly scanned file, or a new class).
export function raises(counts, baseline) {
  const out = [];
  for (const key of Object.keys(counts)) {
    for (const kind of KINDS) {
      const base = baseline[key]?.[kind] ?? 0;
      if (counts[key][kind] > base) out.push({ key, kind, now: counts[key][kind], base });
    }
  }
  return out;
}

export function totals(counts) {
  const perKind = {};
  for (const k of KINDS) perKind[k] = 0;
  for (const byKind of Object.values(counts)) for (const k of KINDS) perKind[k] += byKind[k];
  return { perKind, total: KINDS.reduce((a, k) => a + perKind[k], 0) };
}
