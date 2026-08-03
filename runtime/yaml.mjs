/** Minimal YAML subset loader (maps/lists/scalars) — no external dep. */
import { readFileSync } from 'node:fs';

/**
 * Parse a restricted YAML subset used by config/*.yaml.
 * Supports: comments, nested maps, lists, scalars, block scalars (> / |).
 * Not a full YAML 1.2 implementation.
 */
export function parseYaml(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  /** @type {{ indent: number, container: any, key?: string, kind: 'map'|'list' }[]} */
  const stack = [{ indent: -1, container: root, kind: 'map' }];

  function current() {
    return stack[stack.length - 1];
  }

  function setInMap(map, key, value) {
    map[key] = value;
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^ */)[0].length;
    line = line.slice(indent);
    while (stack.length > 1 && indent <= current().indent) stack.pop();
    const ctx = current();

    // list item
    if (line.startsWith('- ')) {
      const rest = line.slice(2).trim();
      let list;
      if (ctx.kind === 'list') {
        list = ctx.container;
      } else if (ctx.kind === 'map' && ctx.key != null) {
        if (!Array.isArray(ctx.container[ctx.key])) ctx.container[ctx.key] = [];
        list = ctx.container[ctx.key];
        stack.push({ indent, container: list, kind: 'list' });
      } else {
        continue;
      }
      if (rest.includes(': ') || (rest.endsWith(':') && !rest.startsWith('"'))) {
        const obj = {};
        list.push(obj);
        if (rest.endsWith(':') && !rest.slice(0, -1).includes(':')) {
          const k = unquote(rest.slice(0, -1).trim());
          obj[k] = null;
          stack.push({ indent, container: obj, key: k, kind: 'map' });
        } else {
          const idx = rest.indexOf(':');
          const k = unquote(rest.slice(0, idx).trim());
          const v = parseScalar(rest.slice(idx + 1).trim());
          obj[k] = v;
          stack.push({ indent, container: obj, kind: 'map' });
        }
      } else {
        list.push(parseScalar(rest));
      }
      continue;
    }

    // key: value or key:
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = unquote(line.slice(0, colon).trim());
    let val = line.slice(colon + 1).trim();
    if (val.startsWith('#')) val = '';
    if (val === '' || val === '|' || val === '>') {
      // nested map or block
      if (ctx.kind === 'map') {
        if (ctx.container[key] == null || typeof ctx.container[key] !== 'object') {
          ctx.container[key] = {};
        }
        stack.push({ indent, container: ctx.container[key], kind: 'map' });
        // mark key for subsequent list under this map key
        stack[stack.length - 1].key = undefined;
        // For lists that follow under this key, we need the parent to know the key.
        // Push a map context whose container is the parent map, with key set:
        stack.pop();
        setInMap(ctx.container, key, {});
        stack.push({ indent, container: ctx.container, key, kind: 'map' });
        // Actually child map should be the new object:
        stack.pop();
        const child = {};
        setInMap(ctx.container, key, child);
        stack.push({ indent, container: child, key, kind: 'map' });
      }
      if (val === '|' || val === '>') {
        // collect block scalar
        const parts = [];
        const baseIndent = indent;
        while (i + 1 < lines.length) {
          const nl = lines[i + 1];
          if (!nl.trim()) {
            parts.push('');
            i++;
            continue;
          }
          const ni = nl.match(/^ */)[0].length;
          if (ni <= baseIndent) break;
          parts.push(nl.slice(baseIndent + 2)); // typical 2-space pad
          i++;
        }
        const joined = parts.join(val === '|' ? '\n' : ' ').trim();
        // replace object with scalar
        if (ctx.kind === 'map') {
          // walk: last pushed child for key
          const parent = stack[stack.length - 2];
          if (parent && parent.kind === 'map') {
            // find which key points to empty object
            for (const [k, v] of Object.entries(parent.container)) {
              if (v === current().container) {
                parent.container[k] = joined;
                stack.pop();
                break;
              }
            }
          }
        }
      }
      continue;
    }
    // inline value
    if (ctx.kind === 'map') {
      // If we're on a map that was created as empty placeholder with a key on parent...
      setInMap(ctx.container, key, parseScalar(val));
    }
  }
  return root;
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s) {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  // strip trailing comment
  const hash = s.indexOf(' #');
  if (hash !== -1) s = s.slice(0, hash).trim();
  return unquote(s);
}

export function loadYamlFile(path) {
  return parseYaml(readFileSync(path, 'utf8'));
}
