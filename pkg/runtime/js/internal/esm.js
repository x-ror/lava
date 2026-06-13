// ESM-to-CommonJS source transform.
//
// JavaScriptCore's classic C API (JSEvaluateScript) only runs *script*-goal
// source, so Lava cannot hand it `import` / `export` syntax directly. This module
// rewrites the static module syntax used by the Node compatibility corpus into an
// equivalent CommonJS body and wraps it so the existing native `require` resolves
// specifiers. The wrapper exposes `import.meta` (as `__import_meta`) and tags the
// resulting namespace with a non-enumerable `__esModule` flag so CJS<->ESM default
// interop matches Node/Babel/TS conventions.
//
// The scanner is string/template/comment-aware: a masking pass (buildMask) blanks
// every character inside a string, template literal, or comment so structural
// scanning (statement boundaries, brace depth, the import/export keywords
// themselves) never trips over `{` in a string, an `import` line inside a template
// literal, a commented-out `export`, or a trailing line comment.
//
// It handles only static, statement-position import/export forms. Anything it does
// not recognize (e.g. destructuring exports, top-level await) is surfaced as an
// explicit error rather than silently mistranslated. Dynamic `import()` and
// `import.meta` member access are left to JSC. Note: named imports/exports are
// value copies, not live bindings — a later mutation of an `export let` is not
// reflected in importers (a transform limitation, not modeled here).
//
// Evaluates to a function: transform(source, url, filename, dirname) -> string.
(function () {
  'use strict';

  function jsonString(value) {
    return JSON.stringify(String(value));
  }

  var IDENT = '[A-Za-z_$][\\w$]*';

  // buildMask returns a copy of `src` with every character inside a string, a
  // template literal, a line comment, or a block comment replaced by a space
  // (newlines preserved, so indices/line structure are unchanged). Template
  // `${ ... }` expressions are kept as code so nested braces/strings are tracked
  // correctly. The result is used only for structural scanning; the original
  // source is what gets emitted.
  function buildMask(src) {
    var out = '';
    // Stack of modes: 'code' (with brace depth for ${} tracking), 'line',
    // 'block', 'sq' (single-quote), 'dq' (double-quote), 'tpl' (template).
    var stack = [{ mode: 'code', brace: 0 }];
    function top() {
      return stack[stack.length - 1];
    }
    var i = 0;
    while (i < src.length) {
      var c = src.charAt(i);
      var d = i + 1 < src.length ? src.charAt(i + 1) : '';
      var m = top().mode;

      if (m === 'code') {
        if (c === '/' && d === '/') {
          stack.push({ mode: 'line' });
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '/' && d === '*') {
          stack.push({ mode: 'block' });
          out += '  ';
          i += 2;
          continue;
        }
        if (c === "'") {
          stack.push({ mode: 'sq' });
          out += ' ';
          i++;
          continue;
        }
        if (c === '"') {
          stack.push({ mode: 'dq' });
          out += ' ';
          i++;
          continue;
        }
        if (c === '`') {
          stack.push({ mode: 'tpl' });
          out += ' ';
          i++;
          continue;
        }
        if (c === '{') {
          top().brace++;
          out += c;
          i++;
          continue;
        }
        if (c === '}') {
          if (top().brace === 0 && stack.length > 1 && stack[stack.length - 2].mode === 'tpl') {
            // Closes a `${ ... }` template expression; the brace belongs to the
            // template, so blank it (it is not a statement brace).
            stack.pop();
            out += ' ';
            i++;
            continue;
          }
          if (top().brace > 0) top().brace--;
          out += c;
          i++;
          continue;
        }
        out += c;
        i++;
        continue;
      }

      if (m === 'line') {
        if (c === '\n') {
          stack.pop();
          out += '\n';
        } else {
          out += ' ';
        }
        i++;
        continue;
      }

      if (m === 'block') {
        if (c === '*' && d === '/') {
          stack.pop();
          out += '  ';
          i += 2;
          continue;
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
        continue;
      }

      if (m === 'sq' || m === 'dq') {
        if (c === '\\' && d !== '') {
          out += '  ';
          i += 2;
          continue;
        }
        if ((m === 'sq' && c === "'") || (m === 'dq' && c === '"')) {
          stack.pop();
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
        continue;
      }

      if (m === 'tpl') {
        if (c === '\\' && d !== '') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c === '`') {
          stack.pop();
          out += ' ';
          i++;
          continue;
        }
        if (c === '$' && d === '{') {
          // Enter a template expression: subsequent chars are code until the
          // matching `}` (tracked via the code frame's brace depth above).
          stack.push({ mode: 'code', brace: 0 });
          out += '  ';
          i += 2;
          continue;
        }
        out += c === '\n' ? '\n' : ' ';
        i++;
        continue;
      }

      // Unreachable, but keep length parity defensively.
      out += c === '\n' ? '\n' : ' ';
      i++;
    }
    return out;
  }

  // preReplaceMeta rewrites `import.meta` -> `__import_meta` everywhere it appears
  // as real code (per the mask), keeping src and mask in sync (the replacement is
  // all code, so the mask copy is identical). Done up front so the statement
  // scanner never mistakes `import.meta` for an import statement and so member
  // access works inside any expression.
  function preReplaceMeta(src, mask) {
    var s = '';
    var m = '';
    var i = 0;
    while (i < src.length) {
      if (mask.substr(i, 11) === 'import.meta') {
        s += '__import_meta';
        m += '__import_meta';
        i += 11;
      } else {
        s += src.charAt(i);
        m += mask.charAt(i);
        i++;
      }
    }
    return { src: s, mask: m };
  }

  // splitTopLevel splits `text` on `sep` at brace/paren/bracket depth 0, ignoring
  // separators inside strings/comments/templates (via a fresh mask).
  function splitTopLevel(text, sep) {
    var mask = buildMask(text);
    var out = [];
    var depth = 0;
    var start = 0;
    for (var k = 0; k < text.length; k++) {
      var ch = mask.charAt(k);
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth > 0) depth--;
      } else if (ch === sep && depth === 0) {
        out.push(text.slice(start, k));
        start = k + 1;
      }
    }
    out.push(text.slice(start));
    return out;
  }

  // Split a `{ a, b as c }` binding list into trimmed, non-empty specifiers.
  function splitSpecs(inner) {
    var out = [];
    var parts = inner.split(',');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p) out.push(p);
    }
    return out;
  }

  // Render an import binding list as an object-destructuring pattern. `a` stays
  // `a`; `a as b` becomes `a: b`; the reserved `default` is a valid key here.
  function destructurePattern(inner) {
    var specs = splitSpecs(inner);
    var rendered = [];
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      var as = p.match(new RegExp('^(' + IDENT + ')\\s+as\\s+(' + IDENT + ')$'));
      if (as) {
        rendered.push(as[1] + ': ' + as[2]);
        continue;
      }
      if (new RegExp('^' + IDENT + '$').test(p)) {
        rendered.push(p);
        continue;
      }
      throw new Error('lava ESM transform: unsupported import binding: ' + p);
    }
    return rendered.join(', ');
  }

  // Parse an export binding list into {local, exported} pairs. `a` exports `a`;
  // `a as b` exports local `a` under the name `b`.
  function parseExportSpecs(inner) {
    var specs = splitSpecs(inner);
    var pairs = [];
    for (var i = 0; i < specs.length; i++) {
      var p = specs[i];
      var as = p.match(new RegExp('^(' + IDENT + ')\\s+as\\s+(' + IDENT + ')$'));
      if (as) {
        pairs.push({ local: as[1], exported: as[2] });
        continue;
      }
      if (new RegExp('^' + IDENT + '$').test(p)) {
        pairs.push({ local: p, exported: p });
        continue;
      }
      throw new Error('lava ESM transform: unsupported export specifier: ' + p);
    }
    return pairs;
  }

  function transform(source, url, filename, dirname) {
    source = String(source);
    var pre = preReplaceMeta(source, buildMask(source));
    var src = pre.src;
    var mask = pre.mask;
    var n = src.length;

    var pieces = []; // verbatim gaps + transformed statements, emitted in order
    var tail = []; // deferred local named-export assignments (`export { ... }`)
    var counter = 0;

    function nextTemp(prefix) {
      counter++;
      return prefix + counter;
    }

    // --- statement-position detection over the mask ---

    function isStmtStart(pos) {
      for (var k = pos - 1; k >= 0; k--) {
        var ch = mask.charAt(k);
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
        return ch === ';' || ch === '{' || ch === '}';
      }
      return true; // start of source
    }

    function keywordAt(pos) {
      var kw = mask.substr(pos, 6);
      if (kw !== 'import' && kw !== 'export') return null;
      var after = pos + 6 < n ? mask.charAt(pos + 6) : '';
      // Must be a word boundary (not `imported`, `exports`).
      if (after !== '' && /[\w$]/.test(after)) return null;
      return kw;
    }

    function firstNonSpaceAfter(pos) {
      for (var k = pos; k < n; k++) {
        var ch = mask.charAt(k);
        if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') return ch;
      }
      return '';
    }

    // findStmtEnd scans from `from` to the end of the import/export statement: the
    // first `;` at depth 0, or a newline at depth 0 that is not a continuation
    // (the previous meaningful char is not an operator/comma). Returns the index
    // just past the terminator (exclusive of a terminating newline).
    function findStmtEnd(from) {
      var depth = 0;
      var lastMeaningful = '';
      for (var k = from; k < n; k++) {
        var ch = mask.charAt(k);
        if (ch === '(' || ch === '[' || ch === '{') {
          depth++;
          lastMeaningful = ch;
        } else if (ch === ')' || ch === ']' || ch === '}') {
          if (depth > 0) depth--;
          lastMeaningful = ch;
        } else if (ch === ';' && depth === 0) {
          return k + 1;
        } else if (ch === '\n' && depth === 0) {
          // Continuation if the line ended on an operator or comma.
          if ('+-*/%=<>&|^,.?:('.indexOf(lastMeaningful) !== -1) continue;
          return k;
        } else if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') {
          lastMeaningful = ch;
        }
      }
      return n;
    }

    function transformImport(stmt) {
      // Side-effect import: `import 'spec';`
      var m = stmt.match(/^import\s+(['"])([^'"]*)\1\s*;?\s*$/);
      if (m) return 'require(' + jsonString(m[2]) + ');';

      m = stmt.match(/^import\s+([\s\S]+?)\s+from\s+(['"])([^'"]*)\2\s*;?\s*$/);
      if (!m) return null;
      var clause = m[1].trim();
      var req = 'require(' + jsonString(m[3]) + ')';

      // default, * as ns
      var dm = clause.match(new RegExp('^(' + IDENT + ')\\s*,\\s*\\*\\s+as\\s+(' + IDENT + ')$'));
      if (dm) {
        var t1 = nextTemp('__lava_imp_');
        return (
          'var ' +
          t1 +
          ' = ' +
          req +
          '; var ' +
          dm[1] +
          ' = __importDefault(' +
          t1 +
          '); var ' +
          dm[2] +
          ' = __importStar(' +
          t1 +
          ');'
        );
      }
      // default, { named }
      dm = clause.match(new RegExp('^(' + IDENT + ')\\s*,\\s*\\{([\\s\\S]*)\\}$'));
      if (dm) {
        var t2 = nextTemp('__lava_imp_');
        return (
          'var ' +
          t2 +
          ' = ' +
          req +
          '; var ' +
          dm[1] +
          ' = __importDefault(' +
          t2 +
          '); var { ' +
          destructurePattern(dm[2]) +
          ' } = ' +
          t2 +
          ';'
        );
      }
      // * as ns
      dm = clause.match(new RegExp('^\\*\\s+as\\s+(' + IDENT + ')$'));
      if (dm) return 'var ' + dm[1] + ' = __importStar(' + req + ');';
      // { named }
      dm = clause.match(/^\{([\s\S]*)\}$/);
      if (dm) return 'var { ' + destructurePattern(dm[1]) + ' } = ' + req + ';';
      // default
      dm = clause.match(new RegExp('^(' + IDENT + ')$'));
      if (dm) return 'var ' + dm[1] + ' = __importDefault(' + req + ');';

      return null;
    }

    function transformExport(stmt) {
      // export default <expr|decl>
      var m = stmt.match(/^export\s+default\s+([\s\S]+)$/);
      if (m) {
        var expr = m[1].replace(/;?\s*$/, '');
        // A named function/class declaration keeps its binding: declare it (so a
        // hoisted module-scope name exists) and assign it as the default — rather
        // than turning it into an anonymous expression that loses `foo`.
        var fn = expr.match(new RegExp('^(?:async\\s+)?function\\b\\s*\\*?\\s*(' + IDENT + ')'));
        if (fn) {
          return { body: expr + '; module.exports["default"] = ' + fn[1] + ';' };
        }
        var cls = expr.match(new RegExp('^class\\s+(' + IDENT + ')\\b'));
        if (cls) {
          return { body: expr + '; module.exports["default"] = ' + cls[1] + ';' };
        }
        return { body: 'module.exports["default"] = ' + expr + ';' };
      }
      // export { ... } from 'spec'  (re-export named)
      m = stmt.match(/^export\s+\{([\s\S]*)\}\s+from\s+(['"])([^'"]*)\2\s*;?\s*$/);
      if (m) {
        var pairs = parseExportSpecs(m[1]);
        var t = nextTemp('__lava_reexp_');
        var s = '{ var ' + t + ' = require(' + jsonString(m[3]) + ');';
        for (var i = 0; i < pairs.length; i++) {
          s +=
            ' module.exports[' +
            jsonString(pairs[i].exported) +
            '] = ' +
            t +
            '[' +
            jsonString(pairs[i].local) +
            '];';
        }
        return { body: s + ' }' };
      }
      // export * from 'spec'  (re-export all but default)
      m = stmt.match(/^export\s+\*\s+from\s+(['"])([^'"]*)\1\s*;?\s*$/);
      if (m) {
        var ta = nextTemp('__lava_reexp_');
        return {
          body:
            '{ var ' +
            ta +
            ' = require(' +
            jsonString(m[2]) +
            '); for (var __k in ' +
            ta +
            ') { if (__k !== "default") module.exports[__k] = ' +
            ta +
            '[__k]; } }',
        };
      }
      // export { ... }  (local named export) — deferred to the tail so names
      // declared anywhere in the module body are in scope when assigned.
      m = stmt.match(/^export\s+\{([\s\S]*)\}\s*;?\s*$/);
      if (m) {
        var locals = parseExportSpecs(m[1]);
        var t2 = [];
        for (var j = 0; j < locals.length; j++) {
          t2.push(
            'module.exports[' + jsonString(locals[j].exported) + '] = ' + locals[j].local + ';',
          );
        }
        return { body: '', tail: t2 };
      }
      // export const|let|var NAME = ... (possibly multiple declarators) — declare
      // and assign each exported name in place, so a multi-declarator list exports
      // every name and a cycle partner sees them as the body runs.
      m = stmt.match(/^export\s+((?:const|let|var)\b[\s\S]*)$/);
      if (m) {
        var decl = m[1].replace(/;?\s*$/, '');
        var names = declaratorNames(decl);
        var assigns = '';
        for (var d = 0; d < names.length; d++) {
          assigns += ' module.exports[' + jsonString(names[d]) + '] = ' + names[d] + ';';
        }
        return { body: decl + ';' + assigns };
      }
      // export [async] function NAME / export class NAME — declare and assign in
      // place (function declarations hoist, so the export is visible eagerly).
      m = stmt.match(
        new RegExp(
          '^export\\s+((?:async\\s+function|function|class)\\s+(' + IDENT + ')[\\s\\S]*)$',
        ),
      );
      if (m) {
        return {
          body:
            m[1].replace(/;?\s*$/, '') +
            '; module.exports[' +
            jsonString(m[2]) +
            '] = ' +
            m[2] +
            ';',
        };
      }
      return null;
    }

    // declaratorNames extracts the bound names from a `const|let|var a = 1, b = 2`
    // declaration (top-level comma split, leading identifier of each declarator).
    function declaratorNames(decl) {
      var rest = decl.replace(/^(?:const|let|var)\s+/, '');
      var parts = splitTopLevel(rest, ',');
      var names = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        var mm = p.match(new RegExp('^(' + IDENT + ')'));
        if (!mm) {
          throw new Error('lava ESM transform: unsupported export declaration: ' + p);
        }
        names.push(mm[1]);
      }
      return names;
    }

    // --- main scan: copy verbatim, transform import/export statements in place ---

    var i = 0;
    var depth = 0;
    var lastCopy = 0;
    while (i < n) {
      var c = mask.charAt(i);
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        i++;
        continue;
      }
      if (c === ')' || c === ']' || c === '}') {
        if (depth > 0) depth--;
        i++;
        continue;
      }
      if (depth === 0 && (c === 'i' || c === 'e')) {
        var kw = keywordAt(i);
        if (kw && isStmtStart(i)) {
          var after = firstNonSpaceAfter(i + 6);
          // Leave dynamic import() and import.meta (already rewritten) to JSC.
          if (kw === 'import' && (after === '(' || after === '.')) {
            i += 6;
            continue;
          }
          var end = findStmtEnd(i + 6);
          var stmt = src.slice(i, end).replace(/\s+$/, '');
          // Emit the verbatim gap before this statement.
          pieces.push(src.slice(lastCopy, i));
          if (kw === 'import') {
            var im = transformImport(stmt);
            if (im === null) {
              throw new Error(
                'lava ESM transform: unsupported import form: ' + stmt.split('\n')[0],
              );
            }
            pieces.push(im);
          } else {
            var ex = transformExport(stmt);
            if (ex === null) {
              throw new Error(
                'lava ESM transform: unsupported export form: ' + stmt.split('\n')[0],
              );
            }
            if (ex.body) pieces.push(ex.body);
            if (ex.tail) tail = tail.concat(ex.tail);
          }
          lastCopy = end;
          i = end;
          continue;
        }
      }
      i++;
    }
    pieces.push(src.slice(lastCopy));

    var bodyStr = pieces.join('');
    var tailStr = tail.join('\n');

    return [
      '(function(){',
      'var module = { exports: {}, children: [] };',
      'var exports = module.exports;',
      'Object.defineProperty(module.exports, "__esModule", { value: true });',
      // Register this module's (still-empty) namespace in the loader cache BEFORE
      // running the body, mirroring the CommonJS wrapper's __lava_precache. Without
      // this an ESM<->ESM import cycle (A imports B imports A) re-enters require
      // with nothing cached and recurses to a stack overflow; with it the cycle
      // partner sees the partial namespace, matching Node. (__lava_precache is a
      // no-op for `lava eval` sources, where the global is absent.)
      'if (typeof __lava_precache === "function") __lava_precache(' +
        jsonString(filename) +
        ', module.exports);',
      'function __importDefault(m){ return (m && m.__esModule) ? m["default"] : m; }',
      'function __importStar(m){ if (m && m.__esModule) return m; var ns = {}; if (m) { for (var k in m) ns[k] = m[k]; } ns["default"] = m; return ns; }',
      '(function(require, module, exports, __filename, __dirname, __import_meta){',
      '"use strict";',
      bodyStr,
      tailStr,
      // Bind require to this module's directory so relative specifiers (and any
      // deferred require) resolve against it, not the entry file's directory.
      '})(function(s){ return require(s, ' +
        jsonString(dirname) +
        '); }, module, exports, ' +
        jsonString(filename) +
        ', ' +
        jsonString(dirname) +
        ', { url: ' +
        jsonString(url) +
        ' });',
      'return module.exports;',
      '})()',
    ].join('\n');
  }

  return transform;
})();
