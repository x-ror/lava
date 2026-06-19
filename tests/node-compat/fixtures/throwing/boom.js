// A module that throws while loading. Its body bumps a shared counter BEFORE it
// throws, so a caller can observe whether the body re-runs on a later require:
// Node drops a module that threw during load from the cache, so requiring it again
// re-executes the body (and Lava must match). Used by 36-require-throw-recache.js.
globalThis.__throwingModuleRuns = (globalThis.__throwingModuleRuns || 0) + 1;
throw new Error('boom-on-load');
