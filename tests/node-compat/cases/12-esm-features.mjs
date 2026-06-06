// Broader ESM coverage on top of 01-esm.mjs: namespace import, default+named
// import from an ESM module, aliased named import, and a re-export.
import assert from 'node:assert/strict';
import * as pathNS from 'node:path';
import add, {tag} from '../fixtures/esm-default.mjs';
import {basename as reBasename, extra} from '../fixtures/esm-reexport.mjs';
import {fileURLToPath} from 'node:url';

// Namespace import exposes the module's named exports.
assert.equal(typeof pathNS.basename, 'function');
assert.equal(pathNS.basename('/a/b/c.js'), 'c.js');

// Default + named import from an ESM module.
assert.equal(add(20, 22), 42);
assert.equal(tag, 'esm-default');

// Re-export: a name forwarded from another module, plus a local export.
assert.equal(typeof reBasename, 'function');
assert.equal(reBasename('/x/y/z.txt'), 'z.txt');
assert.equal(extra, 7);

// import.meta.url round-trips through node:url back to this file.
assert.equal(typeof import.meta.url, 'string');
assert.equal(fileURLToPath(import.meta.url).endsWith('12-esm-features.mjs'), true);

console.log('esm-features-ok');
