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
    if (!hasOwn.call(factories, key)) return undefined;
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
  req('buffer');
  req('stream/web');
  req('fetch');
  req('abort');
  req('encoding');
  req('url');
  req('structured_clone');
  req('crypto');

  return req;
});
