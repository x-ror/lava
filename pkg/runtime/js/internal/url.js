// Minimal node:url surface for the ESM compatibility path.
//
// `fileURLToPath` is the inverse of the `file://` URL the loader synthesizes for
// `import.meta.url` (file:// + absolute path), so ESM code can recover its own
// filesystem path. Only the `file:` scheme is handled; the broader WHATWG URL API
// (the `URL` class, `pathToFileURL` returning a URL object, etc.) is intentionally
// absent rather than approximated.
(function (require, module, exports) {
  'use strict';

  function fileURLToPath(input) {
    var url = typeof input === 'string' ? input : String(input);
    if (url.slice(0, 5).toLowerCase() !== 'file:') {
      var schemeErr = new TypeError('The URL must be of scheme file');
      schemeErr.code = 'ERR_INVALID_FILE_URL_SCHEME';
      throw schemeErr;
    }
    var rest = url.slice(5);
    // Drop the authority component (file://host/path). The host must be empty
    // or "localhost" — anything else (e.g. file://evil.com/x) is rejected.
    if (rest.slice(0, 2) === '//') {
      rest = rest.slice(2);
      var slash = rest.indexOf('/');
      var host = slash === -1 ? rest : rest.slice(0, slash);
      if (host !== '' && host.toLowerCase() !== 'localhost') {
        var hostErr = new TypeError(
          'File URL host must be "localhost" or empty on ' + process.platform,
        );
        hostErr.code = 'ERR_INVALID_FILE_URL_HOST';
        throw hostErr;
      }
      rest = slash === -1 ? '/' : rest.slice(slash);
    }
    // A file path carries no query or fragment.
    var hash = rest.indexOf('#');
    if (hash !== -1) rest = rest.slice(0, hash);
    var query = rest.indexOf('?');
    if (query !== -1) rest = rest.slice(0, query);
    // Reject encoded path separators (%2F / %2f) — decoding them would allow
    // path-separator smuggling (Node throws ERR_INVALID_FILE_URL_PATH).
    if (/%(2f)/i.test(rest)) {
      var sepErr = new TypeError('File URL path must not include encoded / characters');
      sepErr.code = 'ERR_INVALID_FILE_URL_PATH';
      throw sepErr;
    }
    return decodeURIComponent(rest);
  }

  module.exports = { fileURLToPath: fileURLToPath };
});
