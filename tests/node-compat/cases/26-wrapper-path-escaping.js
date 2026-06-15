// The CJS module wrapper splices __filename/__dirname/cache-key/require-base into
// generated source; those literals must be escaped (issue #94). A directory whose
// name contains a quote and a newline — both legal on POSIX — would otherwise
// terminate the literal early and inject into / break the module text. (The same
// escaping is what keeps Windows drive paths' backslashes from reading as string
// escapes.) Build such a directory at runtime, require a module from it, and
// confirm __dirname/__filename round-trip intact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// POSIX allows a quote and newline in a filename — both would break the spliced
// literal if unescaped. On Windows those are illegal in names, but every path
// there contains backslashes (the separator), which is the same escaping hazard;
// an apostrophe adds a quote character that is legal on Windows.
const weird = process.platform === 'win32' ? "weird'name" : 'we"ird\nname';
const base = path.join(__dirname, '..', 'fixtures', 'wrapper-escape-tmp');
const dir = path.join(base, weird);
fs.mkdirSync(dir, { recursive: true });

const modPath = path.join(dir, 'mod.js');
fs.writeFileSync(modPath, 'module.exports = { dir: __dirname, file: __filename, v: 42 };\n');

try {
  const m = require(modPath);
  assert.equal(m.v, 42);
  // The spliced literals must equal the real paths, not a corrupted/truncated form.
  assert.equal(m.file, modPath);
  assert.equal(m.dir, dir);
  assert.ok(m.dir.indexOf(weird) !== -1);
  console.log('ok');
} finally {
  fs.rmSync(base, { recursive: true });
}
