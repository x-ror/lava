// Internal built-in module loader. Given a map of module name -> factory
// function `(require, module, exports) => exports?`, it returns a `require`
// implementation that instantiates each module lazily, caches it, strips the
// `node:` prefix, and lets internal modules require one another (with the usual
// CommonJS partial-exports behavior on cycles). The resolver is what native
// `require()` consults before touching the filesystem.
(function (factories, natives) {
  'use strict';

  var cache = Object.create(null);
  natives = natives || Object.create(null);
  var hasOwn = Object.prototype.hasOwnProperty;

  function normalize(name) {
    var key = name.indexOf('node:') === 0 ? name.slice(5) : name;
    // assert/strict shares assert's (already strict) implementation.
    if (key === 'assert/strict') key = 'assert';
    return key;
  }

  function req(name) {
    var key = normalize(name);
    if (key in cache) return cache[key];
    // Look up own properties only: `factories` may inherit from Object.prototype,
    // so a bracket lookup of 'constructor'/'toString' would otherwise return an
    // inherited function and mis-resolve those specifiers instead of yielding the
    // "not a builtin" (undefined) that lets native_require_cb fall through.
    if (!hasOwn.call(factories, key)) return;
    var factory = factories[key];
    var module = { exports: {} };
    // Seed the cache before running the factory so a require cycle resolves
    // to the partially-built exports object instead of looping forever.
    cache[key] = module.exports;
    // natives[key] (or undefined) carries any Odin-backed primitives for this
    // module — e.g. crypto's CSPRNG and one-shot hash/hmac/pbkdf2.
    var result = factory(req, module, module.exports, natives[key]);
    cache[key] = result !== undefined ? result : module.exports;
    return cache[key];
  }

  // Eagerly instantiate modules that install globals (Buffer; the Web Streams
  // ReadableStream/WritableStream/TransformStream family; fetch/Response/Headers/
  // Request; crypto's WHATWG global; URL/URLSearchParams), so they are present
  // even when user code never requires them explicitly. `stream/web` runs before
  // `fetch` because fetch builds response bodies from the public ReadableStream.
  // `url` runs after `buffer` (so it preserves the URL.createObjectURL/
  // revokeObjectURL statics buffer attaches) and after `encoding` (which installs
  // the TextEncoder/TextDecoder globals url uses); url also lazily creates its
  // codecs, so the order is belt-and-suspenders rather than load-bearing.
  // primordials is eager-loaded FIRST, before any other internal module and well
  // before user code, so it captures pristine intrinsics (see primordials.js).
  // Other modules require('primordials') and get this cached, pristine table.
  req('primordials');
  req('buffer');

  // Hand `fs` a PRISTINE Buffer, captured here rather than inside fs.js.
  //
  // fs.js is a lazy module: its factory does not run until user code calls require('fs'),
  // which is arbitrarily late. A `require('buffer').Buffer` capture at ITS module-eval
  // therefore reads whatever the exports object holds by then, and that object is the one
  // user code holds too — so a dependency's top-level `require('buffer').Buffer = shim`
  // makes every later fs read return, and disclose, whatever the shim wants. Node's fs
  // builds its result from an internal binding user code cannot reach.
  //
  // §5's "capture at module-eval" rule is only sound because the LOADER runs before user
  // code, and that is true of the eager list above, not of a lazy module. So the capture
  // belongs here, one line after buffer is instantiated, where the ordering is provable.
  // fs receives it through its natives argument like any other binding.
  var pristineBuffer = req('buffer').Buffer;
  if (natives.fs) {
    natives.fs.Buffer = pristineBuffer;
    natives.fs.bufferFrom = pristineBuffer.from;
    natives.fs.bufferIsEncoding = pristineBuffer.isEncoding;
    natives.fs.bufferToString = pristineBuffer.prototype.toString;
  }

  req('stream/web');
  req('fetch');
  req('abort');
  req('encoding');
  req('url');
  req('structured_clone');
  req('crypto');

  // Internal-only modules: internal factories require() them through `req` above,
  // but they must NOT be reachable through the public resolver native require()
  // consults, and publicReq hides them. Two reasons a name lands here:
  //   1. It has no Node builtin at all — require('node:primordials') is
  //      ERR_UNKNOWN_BUILTIN_MODULE; util.parseArgs / util.MIMEType are the public
  //      surfaces for parse_args / mime.
  //   2. Its user-facing API is a GLOBAL, not a module — fetch, AbortController,
  //      TextEncoder/TextDecoder, and structuredClone are installed on globalThis
  //      by the eager loads above. `encoding` in particular is a real npm package
  //      (a transitive dep of node-fetch), so answering require('encoding') from
  //      here would shadow it and break the ecosystem. Hiding the specifier leaves
  //      the globals intact while letting the filesystem resolver find the package.
  // `__proto__: null` because this literal is indexed by a CALLER-SUPPLIED specifier
  // (`INTERNAL_ONLY[normalize(name)]` below) — §5's one vector the ratchet cannot
  // count. Inherited truthiness makes publicReq answer `undefined` for a real builtin,
  // so `require('node:http')` falls through to filesystem resolution: a denial, or a
  // shadow when an npm package of that name is installed (`os`, `path`, `url`, `util`
  // and `events` all exist on the registry). The sibling lookup at `factories` above
  // already guards this with hasOwn; this table was missed.
  var INTERNAL_ONLY = {
    __proto__: null,
    primordials: true,
    parse_args: true,
    parse_env: true,
    mime: true,
    fetch: true,
    abort: true,
    encoding: true,
    structured_clone: true,
    stdio: true,
  };
  function publicReq(name) {
    if (INTERNAL_ONLY[normalize(name)]) return undefined;
    return req(name);
  }

  // The ESM source transform is the one internal module that cannot
  // require('primordials'): the runtime evaluates js/internal/esm.js standalone and
  // keeps the resulting function on Runtime_State, deliberately NOT registering it
  // as a requireable module (see globals.odin), so it never gets a `require`. It
  // still needs the pristine table — it emits executed source, so a live intrinsic
  // there is code injection, not a wrong answer.
  //
  // Hand the ALREADY-INSTANTIATED table out here rather than letting the runtime
  // evaluate primordials a second time, which would capture a parallel set and quietly
  // split the "captured once, before user code" guarantee in two.
  //
  // This is not a new user-visible surface: the resolver object never reaches user
  // code. What user code calls is the native require callback, which consults this
  // function through Runtime_State.builtin_require and returns only module exports.
  publicReq.primordials = req('primordials');

  // stdio installs process.stdout/process.stderr. It cannot be eager-required here: the
  // loader runs BEFORE install_process puts `process` on the global, and stdio pulls in
  // `stream`, which reaches for it. Exposed as a closure so globals.odin can call it at
  // the right moment, after the process object exists.
  publicReq.installStdio = function (proc) {
    req('stdio').install(proc);
  };

  return publicReq;
});
