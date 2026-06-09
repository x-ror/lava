// Required by cases/18-async-require.js. The require('./inner') below runs in a
// deferred callback (after this module's body returned), so it must still resolve
// against THIS module's directory (fixtures/deferred), not the entry's. Pre-fix
// Lava resolved deferred requires against the entry dir and threw MODULE_NOT_FOUND.
module.exports = new Promise((resolve, reject) => {
  setTimeout(() => {
    try {
      resolve(require('./inner').tag);
    } catch (e) {
      reject(e);
    }
  }, 0);
});
