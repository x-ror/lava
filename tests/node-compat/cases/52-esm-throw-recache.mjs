// An ESM module that throws while evaluating must NOT stay cached as an empty
// namespace. The ESM wrapper pre-registers the module's (still-empty) exports in
// the loader cache BEFORE running the body so an import cycle can resolve; if the
// body then throws, that empty entry has to be dropped. Otherwise a later import
// finds the cached empty-but-__esModule namespace and SILENTLY SUCCEEDS with no
// exports — strictly worse than an error.
//
// Observable contract (what this oracle asserts, matching Node): the first import
// throws and every later import of the same module also throws — never resolves.
// The error TEXT is normalized to a fixed token because Node and Lava word the
// dynamic-import failure differently; the load-bearing fact is throw-vs-resolve.
//
// Async case: ends with main().catch(...) per the suite convention so a failure
// reports cleanly without depending on the rejection plumbing it exercises.

async function attempt() {
  try {
    await import('../fixtures/esm-throwing/boom.mjs');
    return 'RESOLVED';
  } catch {
    return 'THREW';
  }
}

async function main() {
  const first = await attempt();
  const second = await attempt();
  const third = await attempt();
  console.log('first:', first);
  console.log('second:', second);
  console.log('third:', third);
  console.log('ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
