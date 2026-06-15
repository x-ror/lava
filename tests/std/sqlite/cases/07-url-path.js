// A file: URL is an accepted DatabaseSync path (review follow-up to #91). Node
// exposes a global URL; Lava does not yet (its node:url only offers
// fileURLToPath — global URL is tracked in #61), so it accepts a WHATWG-shaped
// object and resolves it via node:url. The test exercises whichever the runtime
// provides and asserts the same observable result, diffed against Node as oracle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// sqlite is unavailable on Windows builds (the oracle compares Lava only where it
// runs), and Windows file: URL ↔ path mapping is its own concern; keep this case
// POSIX-only. stdout stays identical so the Node-only smoke run still matches.
if (process.platform !== 'win32') {
  const tmp = (process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp').replace(
    /[/\\]$/,
    '',
  );
  // mkdtempSync (#166) gives the Node oracle and the Lava run their own isolated
  // directories, so they never collide on a shared db path — this case used to
  // hard-code one and had to be written idempotently to tolerate a previous run's
  // leftover file. With an isolated dir the schema setup can be a plain CREATE.
  const dir = fs.mkdtempSync(tmp + '/lava-sqlite-url-');
  const dbPath = dir + '/db.sqlite';
  const href = 'file://' + dbPath;
  // Real URL under Node; a WHATWG-shaped object under Lava (no global URL yet).
  const location = typeof URL === 'function' ? new URL(href) : { href: href, protocol: 'file:' };

  const db = new DatabaseSync(location);
  db.exec('CREATE TABLE t (x)');
  db.prepare('INSERT INTO t VALUES (7)').run();
  assert.equal(db.prepare('SELECT x FROM t').get().x, 7);
  db.close();

  // Clean teardown now that fs has unlinkSync + rmdirSync (#166); a clean close in
  // the default rollback-journal mode leaves only the db file behind.
  fs.unlinkSync(dbPath);
  fs.rmdirSync(dir);
}

console.log('ok');
