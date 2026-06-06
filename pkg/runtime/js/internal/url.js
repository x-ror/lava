// Minimal node:url surface for the ESM compatibility path.
//
// `fileURLToPath` is the inverse of the `file://` URL the loader synthesizes for
// `import.meta.url` (file:// + absolute path), so ESM code can recover its own
// filesystem path. Only the `file:` scheme is handled; the broader WHATWG URL API
// (the `URL` class, `pathToFileURL` returning a URL object, etc.) is intentionally
// absent rather than approximated.
(function (require, module, exports) {
	"use strict";

	function fileURLToPath(input) {
		var url = typeof input === "string" ? input : String(input);
		if (url.slice(0, 5).toLowerCase() !== "file:") {
			throw new TypeError("The URL must be of scheme file");
		}
		var rest = url.slice(5);
		// Drop the authority component (file://host/path). On POSIX the host must be
		// empty or "localhost"; either way the path begins at the first '/'.
		if (rest.slice(0, 2) === "//") {
			rest = rest.slice(2);
			var slash = rest.indexOf("/");
			rest = slash === -1 ? "/" : rest.slice(slash);
		}
		// A file path carries no query or fragment.
		var hash = rest.indexOf("#");
		if (hash !== -1) rest = rest.slice(0, hash);
		var query = rest.indexOf("?");
		if (query !== -1) rest = rest.slice(0, query);
		return decodeURIComponent(rest);
	}

	module.exports = { fileURLToPath: fileURLToPath };
})
