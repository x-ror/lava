'use strict';

// Shared micro/macro benchmark harness, run under both Node (the oracle) and Lava.
//
// bench(name, fn) times `iterations` calls of fn, repeated `reps` times, and reports
// the BEST (minimum) wall-clock time. Best-of-K suppresses scheduler/GC jitter so the
// node-vs-lava RATIO that bench/run.mjs computes is stable enough to compare and gate
// on (both binaries run the same file on the same machine, so a ratio cancels the
// machine's absolute speed). Timing uses performance.now(), which both runtimes expose.
//
// Each result is emitted as one machine-readable line: "##BENCH## {json}". bench/run.mjs
// captures these from each runtime's stdout and pairs them by name. fn's last return
// value escapes to globalThis each rep so a pure-computation loop cannot be optimized
// away; benches should still return something derived from their work.

const MARKER = '##BENCH##';

function bench(name, fn, opts = {}) {
  const iterations = opts.iterations ?? 100000;
  const warmup = opts.warmup ?? Math.min(iterations, 1000);
  const reps = opts.reps ?? 5;

  for (let i = 0; i < warmup; i++) fn(i);

  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    let last;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) last = fn(i);
    const dt = performance.now() - t0;
    // Keep the loop's product observable so it is not dead-code eliminated.
    globalThis.__benchSink = last;
    if (dt < best) best = dt;
  }

  const result = {
    name,
    iterations,
    reps,
    ms: Number(best.toFixed(4)),
    opsPerSec: best > 0 ? Math.round((iterations / best) * 1000) : 0,
  };
  console.log(`${MARKER} ${JSON.stringify(result)}`);
  return result;
}

module.exports = { bench, MARKER };
