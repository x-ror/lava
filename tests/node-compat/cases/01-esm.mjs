import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {double, label} from '../fixtures/esm-helper.mjs';

const filename = fileURLToPath(import.meta.url);

assert.equal(double(21), 42);
assert.equal(label, 'esm-helper');
assert.equal(path.basename(filename), '01-esm.mjs');
assert.equal(import.meta.url.startsWith('file:'), true);

