// A file: URL is an accepted DatabaseSync path (review follow-up to #91). Node
// exposes a global URL; Lava does not yet (its node:url only offers
// fileURLToPath — see the tracking issue), so it accepts a WHATWG-shaped object
// and resolves it via node:url. The test exercises whichever the runtime provides
// and asserts the same observable result, diffed against Node as the oracle.
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// sqlite is unavailable on Windows builds (the oracle compares Lava only where it
// runs), and Windows file: URL ↔ path mapping is its own concern; keep this case
// POSIX-only. stdout stays identical so the Node-only smoke run still matches.
if (process.platform !== 'win32') {
  const tmp = (process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp').replace(
    /[/\\]$/,
    '',
  );
  const dbPath = tmp + '/lava-sqlite-url-test.db';
  const href = 'file://' + dbPath;
  // Real URL under Node; a WHATWG-shaped object under Lava (no global URL yet).
  const location = typeof URL === 'function' ? new URL(href) : { href: href, protocol: 'file:' };

  const db = new DatabaseSync(location);
  // Idempotent: Lava's fs has no unlinkSync yet, so a previous run's file may
  // remain — make the case insensitive to that rather than depend on cleanup.
  db.exec('CREATE TABLE IF NOT EXISTS t (x)');
  db.exec('DELETE FROM t');
  db.prepare('INSERT INTO t VALUES (7)').run();
  assert.equal(db.prepare('SELECT x FROM t').get().x, 7);
  db.close();
}

console.log('ok');
