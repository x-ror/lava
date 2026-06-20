// util.aborted (async signal->Promise) + util.debuglog. node and lava must match.
const assert = require('node:assert/strict');
const util = require('node:util');

(async () => {
  // aborted: already-aborted resolves undefined
  const ac0 = new AbortController();
  ac0.abort();
  assert.equal(await util.aborted(ac0.signal, {}), undefined);

  // aborted: a later abort resolves with the abort event
  const ac1 = new AbortController();
  const p = util.aborted(ac1.signal, {});
  ac1.abort();
  const ev = await p;
  assert.equal(ev.type, 'abort');

  // aborted is async: bad arguments REJECT (do not throw synchronously)
  await assert.rejects(util.aborted({}, {}), { code: 'ERR_INVALID_ARG_TYPE' });
  await assert.rejects(util.aborted(null, {}), { code: 'ERR_INVALID_ARG_TYPE' });
  await assert.rejects(util.aborted(new AbortController().signal), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  await assert.rejects(util.aborted(new AbortController().signal, null), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  await assert.rejects(util.aborted(new AbortController().signal, 5), {
    code: 'ERR_INVALID_ARG_TYPE',
  });
  // an object/function resource is accepted (resolves on abort, not rejects)
  const acOk = new AbortController();
  const okP = util.aborted(acOk.signal, function () {});
  acOk.abort();
  assert.equal((await okP).type, 'abort');

  // debuglog: with NODE_DEBUG unset the section is disabled — a no-op that returns undefined
  const d = util.debuglog('lavasection');
  assert.equal(typeof d, 'function');
  assert.equal(d.enabled, false);
  assert.equal(d('this is ignored %s %d', 'x', 1), undefined);
  // util.debug is an alias of util.debuglog
  assert.equal(util.debug, util.debuglog);

  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
