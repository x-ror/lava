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
// It intentionally handles only static, statement-position import/export forms.
// Anything it does not recognize (e.g. destructuring exports, top-level await) is
// surfaced as an explicit error rather than silently mistranslated. Dynamic
// `import()` and `import.meta` member access are left to JSC.
//
// Evaluates to a function: transform(source, url, filename, dirname) -> string.
(function () {
  'use strict';

  function jsonString(value) {
    return JSON.stringify(String(value));
  }

  function countChar(text, ch) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === ch) n++;
    }
    return n;
  }

  var IDENT = '[A-Za-z_$][\\w$]*';

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
    var lines = String(source).split('\n');
    var body = [];
    var tail = [];
    var counter = 0;

    function nextTemp(prefix) {
      counter++;
      return prefix + counter;
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
        return { body: 'module.exports["default"] = ' + m[1].replace(/;?\s*$/, '') + ';' };
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
      // export { ... }  (local named export)
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
      // export const|let|var NAME = ...
      m = stmt.match(new RegExp('^export\\s+((?:const|let|var)\\s+(' + IDENT + ')[\\s\\S]*)$'));
      if (m) {
        return { body: m[1], tail: ['module.exports[' + jsonString(m[2]) + '] = ' + m[2] + ';'] };
      }
      // export [async] function NAME / export class NAME
      m = stmt.match(
        new RegExp(
          '^export\\s+((?:async\\s+function|function|class)\\s+(' + IDENT + ')[\\s\\S]*)$',
        ),
      );
      if (m) {
        return { body: m[1], tail: ['module.exports[' + jsonString(m[2]) + '] = ' + m[2] + ';'] };
      }
      return null;
    }

    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.replace(/^\s+/, '');

      // Accumulate continuation lines for an import/export whose `{`...`}` (or
      // function/class body) spans multiple physical lines.
      if (/^(import|export)\b/.test(trimmed)) {
        var j = i;
        while (j + 1 < lines.length && countChar(line, '{') > countChar(line, '}')) {
          j++;
          line += '\n' + lines[j];
        }
        trimmed = line.replace(/^\s+/, '');
        i = j;
      }

      if (/^import\b/.test(trimmed)) {
        var im = transformImport(trimmed);
        if (im === null) {
          throw new Error('lava ESM transform: unsupported import form: ' + trimmed.split('\n')[0]);
        }
        body.push(im);
      } else if (/^export\b/.test(trimmed)) {
        var ex = transformExport(trimmed);
        if (ex === null) {
          throw new Error('lava ESM transform: unsupported export form: ' + trimmed.split('\n')[0]);
        }
        if (ex.body) body.push(ex.body);
        if (ex.tail) tail = tail.concat(ex.tail);
      } else {
        body.push(line);
      }
      i++;
    }

    // `import.meta` is the only meta-property we model; map it to the injected
    // binding. (A naive token replace; acceptable for the trusted compat corpus.)
    var bodyStr = body.join('\n').replace(/\bimport\.meta\b/g, '__import_meta');
    var tailStr = tail.join('\n').replace(/\bimport\.meta\b/g, '__import_meta');

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
