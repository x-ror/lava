// An ESM module that throws during evaluation. Its body bumps a shared counter
// before it throws, so the loader's cache behavior on a failed load is observable.
// A module that threw must NOT be left cached as an empty (but __esModule-tagged)
// namespace: a later import has to throw again, never silently succeed with empty
// exports. Used by 52-esm-throw-recache.mjs.
globalThis.__esmThrowRuns = (globalThis.__esmThrowRuns || 0) + 1;
throw new Error('esm-boom-on-load');
