/**
 * Minimal YAML-subset loader for `config/*.yaml`.
 *
 * Scope on purpose: comments, nested maps, lists (of scalars and of maps),
 * scalars, and block scalars (`|` / `>`). Not YAML 1.2 — no anchors, tags,
 * flow collections or multi-document streams.
 *
 * Reuse note (CLAUDE.md §2): the repo has no YAML dependency and the only
 * consumer is the registry-sync gate, which reads two small files we author.
 * Pulling a parser in for that is more supply chain than the job needs; the
 * subset below is pinned by `runtime/yaml.test.mjs`.
 *
 * A `key:` whose value is on following lines is resolved LAZILY — the shape is
 * unknown until the next content line says whether it is a list or a map. The
 * previous version guessed "map" eagerly and then re-attached the list under a
 * duplicated key, so `providers:` parsed as `{providers: {providers: [...]}}`.
 */
import { readFileSync } from 'node:fs';

/**
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseYaml(text) {
  const root = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // A frame is either resolved (`container` set) or pending (`parent`+`key` set,
  // shape not yet known). `indent` is the indent of the line that opened it.
  /** @type {{indent: number, container?: any, parent?: any, key?: string}[]} */
  const stack = [{ indent: -1, container: root }];

  /** Give a pending frame its shape now that we can see what follows. */
  function resolve(frame, wantList) {
    if (frame.container) return frame.container;
    frame.container = wantList ? [] : {};
    frame.parent[frame.key] = frame.container;
    return frame.container;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    const line = raw.slice(indent).trimEnd();

    // Close every frame this line has dedented out of. A pending frame that is
    // never opened stays null — `key:` with nothing under it means null, and
    // resolving it to {} would invent an empty map.
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      const done = stack.pop();
      if (!done.container) done.parent[done.key] = null;
    }
    const frame = stack[stack.length - 1];

    if (line.startsWith('- ') || line === '-') {
      const list = resolve(frame, true);
      if (!Array.isArray(list)) continue; // malformed: list item under a map value
      const rest = line === '-' ? '' : line.slice(2).trim();
      const colon = splitKey(rest);
      if (colon === -1) {
        list.push(parseScalar(rest));
        continue;
      }
      // `- key: value` opens a map element whose further keys sit at the indent
      // of the text after "- ", not of the dash.
      const obj = {};
      list.push(obj);
      const key = unquote(rest.slice(0, colon).trim());
      const val = rest.slice(colon + 1).trim();
      const elem = { indent, container: obj };
      stack.push(elem);
      if (val === '' || val === '|' || val === '>') {
        const pending = { indent: indent + 2, parent: obj, key };
        stack.push(pending);
        if (val === '|' || val === '>') {
          pending.container = true; // mark resolved; block() writes the scalar
          obj[key] = block(lines, i, indent + 2, val);
          i = block.lastIndex;
          stack.pop();
        }
      } else {
        obj[key] = parseScalar(val);
      }
      continue;
    }

    const colon = splitKey(line);
    if (colon === -1) continue;
    const key = unquote(line.slice(0, colon).trim());
    const val = line.slice(colon + 1).trim();
    const map = resolve(frame, false);
    if (Array.isArray(map)) continue; // malformed: bare key inside a list

    if (val === '|' || val === '>') {
      map[key] = block(lines, i, indent, val);
      i = block.lastIndex;
      continue;
    }
    if (val === '' || val.startsWith('#')) {
      stack.push({ indent, parent: map, key });
      continue;
    }
    map[key] = parseScalar(val);
  }

  // Trailing `key:` with no body.
  while (stack.length > 1) {
    const done = stack.pop();
    if (!done.container) done.parent[done.key] = null;
  }
  return root;
}

/**
 * Index of the `:` that separates key from value, or -1. Skips a colon inside
 * quotes so `"a: b": c` and a URL value are not split at the wrong place.
 */
function splitKey(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ':' && (i + 1 === s.length || s[i + 1] === ' ')) return i;
  }
  return -1;
}

/**
 * Collect a block scalar. Dedents by the block's own minimum indent rather than
 * a fixed pad, so a nested block keeps its relative shape.
 * Sets `block.lastIndex` to the last line consumed.
 */
function block(lines, start, ownerIndent, style) {
  const body = [];
  let i = start;
  while (i + 1 < lines.length) {
    const next = lines[i + 1];
    if (next.trim() && next.match(/^ */)[0].length <= ownerIndent) break;
    body.push(next);
    i++;
  }
  block.lastIndex = i;
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const pad = Math.min(
    ...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length),
    Infinity,
  );
  const dedented = body.map((l) => (l.trim() ? l.slice(pad) : ''));
  return style === '|' ? dedented.join('\n') : dedented.join(' ').replace(/\s+/g, ' ').trim();
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const hash = s.indexOf(' #');
  if (hash !== -1) s = s.slice(0, hash).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

export function loadYamlFile(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}
