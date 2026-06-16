// Dead-code check for the embedded runtime JS layer.
//
// Runtime JS modules live in pkg/runtime/js and are *not* linked through a JS
// import graph — each is string-embedded into the Odin binary via
//   FOO :: #load("js/internal/foo.js", string)
// and wired up through the JSC native bridge. Tools like knip can't see that
// graph (it lives in Odin, and require() resolves builtin names, not paths), so
// the meaningful "dead file" signal here is simple: a runtime JS file that no
// .odin source `#load`s is orphaned and can be deleted.
//
// Usage: bun run scripts/check-orphan-js.mjs   (exit 1 if any orphan found)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const JS_DIR = join(ROOT, 'pkg', 'runtime', 'js');
const RUNTIME_DIR = join(ROOT, 'pkg', 'runtime');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// All #load("js/...") references across every .odin file under pkg/runtime.
const loaded = new Set();
for (const file of walk(RUNTIME_DIR)) {
  if (!file.endsWith('.odin')) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/#load\(\s*"([^"]+\.js)"/g)) loaded.add(m[1]);
}

const orphans = [];
for (const file of walk(JS_DIR)) {
  if (!file.endsWith('.js')) continue;
  // Reference key is the path as written in #load, e.g. "js/internal/foo.js".
  const key = relative(RUNTIME_DIR, file).split(sep).join('/');
  if (!loaded.has(key)) orphans.push(key);
}

if (orphans.length > 0) {
  console.error(`Found ${orphans.length} orphaned runtime JS file(s) — not #load-ed by any .odin source:`);
  for (const o of orphans) console.error(`  pkg/runtime/${o}`);
  process.exit(1);
}

console.log(`OK: all runtime JS files are loaded by the Odin host.`);
