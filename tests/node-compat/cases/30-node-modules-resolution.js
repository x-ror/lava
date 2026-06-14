// node_modules + directory resolution (issue #97): bare specifiers walk up
// node_modules, directories resolve via package.json "main" then index.js, scoped
// and subpath specifiers work, and a nested node_modules shadows a top-level dep.
// The tree is built at runtime (node_modules is gitignored) and required through a
// generated app module so the bare requires resolve from inside it. Diffed vs Node.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'fixtures', 'nm-tmp');
const app = path.join(root, 'app');
const nm = path.join(app, 'node_modules');

function write(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

try {
  // Directory module resolved via index.js.
  write(path.join(app, 'lib', 'index.js'), 'module.exports = "LIB_INDEX";');
  // Package with package.json "main".
  write(path.join(nm, 'dep', 'package.json'), '{ "name": "dep", "main": "lib/entry.js" }');
  write(path.join(nm, 'dep', 'lib', 'entry.js'), 'module.exports = "DEP_MAIN";');
  write(path.join(nm, 'dep', 'lib', 'sub.js'), 'module.exports = "DEP_SUB";');
  // Package without "main" -> index.js.
  write(path.join(nm, 'nomain', 'index.js'), 'module.exports = "NOMAIN_INDEX";');
  // Scoped package.
  write(path.join(nm, '@scope', 'pkg', 'package.json'), '{ "main": "main.js" }');
  write(path.join(nm, '@scope', 'pkg', 'main.js'), 'module.exports = "SCOPED";');
  // Nested node_modules shadowing: depA sees its own dep2, not the top-level one.
  write(path.join(nm, 'dep2', 'index.js'), 'module.exports = "DEP2_TOP";');
  write(path.join(nm, 'depA', 'index.js'), 'module.exports = require("dep2");');
  write(
    path.join(nm, 'depA', 'node_modules', 'dep2', 'index.js'),
    'module.exports = "DEP2_NESTED";',
  );

  // The app module runs the bare requires so they resolve from inside the tree.
  write(
    path.join(app, 'index.js'),
    'module.exports = {\n' +
      '  dir: require("./lib"),\n' +
      '  depMain: require("dep"),\n' +
      '  nomain: require("nomain"),\n' +
      '  scoped: require("@scope/pkg"),\n' +
      '  subpath: require("dep/lib/sub"),\n' +
      '  nestedShadow: require("depA"),\n' +
      '  topDep2: require("dep2"),\n' +
      '};\n',
  );

  const r = require(path.join(app, 'index.js'));
  assert.deepEqual(r, {
    dir: 'LIB_INDEX',
    depMain: 'DEP_MAIN',
    nomain: 'NOMAIN_INDEX',
    scoped: 'SCOPED',
    subpath: 'DEP_SUB',
    nestedShadow: 'DEP2_NESTED',
    topDep2: 'DEP2_TOP',
  });

  // A missing bare specifier throws MODULE_NOT_FOUND.
  let err;
  try {
    require('this-package-does-not-exist');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected missing bare specifier to throw');
  assert.equal(err.code, 'MODULE_NOT_FOUND');

  console.log('ok');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
