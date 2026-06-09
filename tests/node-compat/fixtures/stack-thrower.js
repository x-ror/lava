// stack-thrower.js: throws from a fixed source line (issue #29).
// Keep the `throw` on line 4 below; case 16-stack-trace-lines.js hard-codes it.
function boom() {
  throw new Error('stack-trace-line-marker');
}

module.exports = { boom };
