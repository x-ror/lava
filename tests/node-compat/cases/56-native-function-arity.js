// The `.length` of the natives Lava injects onto globalThis.
//
// Lava builds these two different ways (pkg/runtime/require.odin,
// inject_native_function): normally through JSC's private host-call ABI, which
// carries a real arity, and — when that ABI is unavailable — through the public
// JSObjectMakeFunctionWithCallback, which cannot carry one and always yields 0.
// The private path is reached by dlsym'ing a C++ mangled symbol, so a JSC upgrade
// that renames it demotes every native to the fallback SILENTLY. This case is
// what makes that loud: `.length` and constructibility are the two observable
// differences between the paths (require.odin records both), and `.length` is
// the one an oracle script can assert cheaply. It also pins the arities
// themselves, which were all 1 until 2026-07-28.
const assert = require('node:assert/strict');

// `name` is carried by both paths, so it is the control: it holds even in the
// fallback configuration skipped below.
assert.equal(setTimeout.name, 'setTimeout');
assert.equal(clearImmediate.name, 'clearImmediate');

// LAVA_HOSTFN_DISABLE is Lava's test-only switch that forces the C-API fallback
// (pkg/jsc/host_function.odin); `make test-lava-nohostfn` sets it for the whole
// oracle suite so the fallback gets exercised at all. There, every arity is 0 and
// cannot be made anything else from the public C API — inject_native_function
// records why. So the arities are asserted in the DEFAULT configuration only:
// that is the one CI and users run, and the one where a silent demotion has to be
// caught. Node ignores the variable, so its output is identical either way.
if (!process.env.LAVA_HOSTFN_DISABLE) {
  // Node: setTimeout(callback, delay) and setInterval(callback, delay) declare
  // two parameters; the rest declare one. Trailing ...args do not count.
  assert.equal(setTimeout.length, 2);
  assert.equal(setInterval.length, 2);
  assert.equal(setImmediate.length, 1);
  assert.equal(clearTimeout.length, 1);
  assert.equal(clearInterval.length, 1);
  assert.equal(clearImmediate.length, 1);
}

console.log('native function arity ok');
