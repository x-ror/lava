'use strict';

// Startup micro-benchmark target: the smallest possible program. bench/run.mjs spawns
// this repeatedly under both runtimes and times the whole process (boot + teardown), so
// it measures interpreter/runtime startup cost rather than any in-script work. It must
// emit no ##BENCH## line — the elapsed time is measured externally by the orchestrator.
process.exitCode = 0;
