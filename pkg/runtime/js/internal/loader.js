// Internal built-in module loader. Given a map of module name -> factory
// function `(require, module, exports) => exports?`, it returns a `require`
// implementation that instantiates each module lazily, caches it, strips the
// `node:` prefix, and lets internal modules require one another (with the usual
// CommonJS partial-exports behavior on cycles). The resolver is what native
// `require()` consults before touching the filesystem.
(function (factories, natives) {
	"use strict";

	var cache = Object.create(null);
	natives = natives || Object.create(null);

	function normalize(name) {
		var key = name.indexOf("node:") === 0 ? name.slice(5) : name;
		// assert/strict shares assert's (already strict) implementation.
		if (key === "assert/strict") key = "assert";
		return key;
	}

	function req(name) {
		var key = normalize(name);
		if (key in cache) return cache[key];
		var factory = factories[key];
		if (factory === undefined) return undefined;
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

	// Eagerly instantiate modules that install globals (Buffer; fetch/Response/
	// Headers/Request), so they are present even when user code never requires
	// them explicitly.
	req("buffer");
	req("fetch");
	req("abort");
	req("encoding");

	return req;
})
