// util.promisify/callbackify/inherits/deprecate and the node:path/posix + node:path/win32
// specifiers. node and lava must produce identical output.
const assert = require('node:assert/strict');
const util = require('node:util');
const path = require('node:path');
const posix = require('node:path/posix');
const win32 = require('node:path/win32');

(async () => {
  // util.promisify — callback-style -> Promise
  const delayedAdd = (a, b, cb) => setImmediate(() => cb(null, a + b));
  assert.equal(await util.promisify(delayedAdd)(2, 3), 5);

  // promisify honors the custom symbol
  const custom = () => {};
  custom[util.promisify.custom] = () => Promise.resolve('CUSTOM');
  assert.equal(await util.promisify(custom)(), 'CUSTOM');
  assert.equal(typeof util.promisify.custom, 'symbol');

  // util.callbackify — async -> (err, value) callback
  const dbl = async (x) => x * 2;
  await new Promise((resolve, reject) =>
    util.callbackify(dbl)(21, (err, v) => {
      try {
        assert.equal(err, null);
        assert.equal(v, 42);
        resolve();
      } catch (e) {
        reject(e);
      }
    }),
  );

  // util.inherits
  function Animal() {}
  Animal.prototype.speak = function () {
    return 'generic';
  };
  function Dog() {}
  util.inherits(Dog, Animal);
  assert.equal(new Dog().speak(), 'generic');
  assert.equal(Dog.super_, Animal);

  // util.deprecate returns a working wrapper (noDeprecation set to keep stderr clean)
  process.noDeprecation = true;
  assert.equal(util.deprecate((x) => x + 1, 'old')(41), 42);

  // node:path/posix and node:path/win32 specifiers, and identity with path.posix/.win32
  assert.equal(posix.join('a', 'b', 'c'), 'a/b/c');
  assert.equal(posix.sep, '/');
  assert.equal(win32.join('a', 'b', 'c'), 'a\\b\\c');
  assert.equal(win32.sep, '\\');
  assert.equal(win32.normalize('C:\\foo\\..\\bar'), 'C:\\bar');
  assert.equal(path.posix, posix);
  assert.equal(path.win32, win32);

  console.log('ok');
})();
