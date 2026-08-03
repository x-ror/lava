/**
 * The YAML subset the registry-sync gate depends on. Pins the shapes that
 * appear in `config/*.yaml` — and the one that used to be parsed wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, loadYamlFile } from './yaml.mjs';
import { CONFIG_AGENTS } from './paths.mjs';

test('a top-level key whose body is a list does not nest under itself', () => {
  // The previous parser produced {providers: {providers: [...]}} here, which is
  // why the registry mirror could disagree with the JSON and nothing noticed.
  const y = parseYaml('providers:\n  - grok\n  - claude\n');
  assert.deepEqual(y, { providers: ['grok', 'claude'] });
});

test('nested maps keep their depth', () => {
  const y = parseYaml(
    ['agents:', '  planner:', '    role: Plan', '    isolation: none'].join('\n'),
  );
  assert.deepEqual(y, { agents: { planner: { role: 'Plan', isolation: 'none' } } });
});

test('scalars are typed, comments and quotes stripped', () => {
  const y = parseYaml(
    ['a: 100', 'b: true', 'c: false', 'd: 1.5', 'e: null', 'f: "x: y"', 'g: hi # tail'].join('\n'),
  );
  assert.deepEqual(y, { a: 100, b: true, c: false, d: 1.5, e: null, f: 'x: y', g: 'hi' });
});

test('a key with nothing under it is null, not an empty map', () => {
  assert.deepEqual(parseYaml('a:\nb: 1\n'), { a: null, b: 1 });
});

test('a list of maps parses element by element', () => {
  const y = parseYaml(['t:', '  - type: issue', '    label: ready', '  - type: cron'].join('\n'));
  assert.deepEqual(y, {
    t: [{ type: 'issue', label: 'ready' }, { type: 'cron' }],
  });
});

test('block scalars fold and keep newlines by style', () => {
  const folded = parseYaml('d: >\n  one\n  two\n');
  assert.equal(folded.d, 'one two');
  const literal = parseYaml('d: |\n  one\n  two\n');
  assert.equal(literal.d, 'one\ntwo');
});

test('a full comment line and a blank line are not content', () => {
  assert.deepEqual(parseYaml('# hi\n\na: 1\n'), { a: 1 });
});

test('the real registry file parses to the documented shape', () => {
  const y = loadYamlFile(CONFIG_AGENTS);
  assert.ok(Array.isArray(y.providers), 'providers must be a list');
  assert.equal(y.agents['pr-gate'].hard_gate, true);
  assert.equal(y.commands['run-pipeline'], 'pipeline');
});
