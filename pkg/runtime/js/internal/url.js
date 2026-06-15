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
    var isWindows = process.platform === 'win32';
    var rest = url.slice(5);
    // Drop the authority component (file://host/path).
    var host = '';
    if (rest.slice(0, 2) === '//') {
      rest = rest.slice(2);
      var slash = rest.indexOf('/');
      host = slash === -1 ? rest : rest.slice(0, slash);
      rest = slash === -1 ? '/' : rest.slice(slash);
    }
    var isLocalhost = host.toLowerCase() === 'localhost';
    // A file path carries no query or fragment.
    var hash = rest.indexOf('#');
    if (hash !== -1) rest = rest.slice(0, hash);
    var query = rest.indexOf('?');
    if (query !== -1) rest = rest.slice(0, query);
    // Reject encoded path separators — decoding them would allow path-separator
    // smuggling (Node throws ERR_INVALID_FILE_URL_PATH). %2F everywhere; %5C
    // (backslash) additionally on Windows, where it is also a separator.
    if (/%2f/i.test(rest) || (isWindows && /%5c/i.test(rest))) {
      var sepErr = new TypeError('File URL path must not include encoded / or \\ characters');
      sepErr.code = 'ERR_INVALID_FILE_URL_PATH';
      throw sepErr;
    }

    if (isWindows) {
      // A non-empty, non-localhost host is a UNC share: file://server/share ->
      // \\server\share. localhost/empty collapse to a local drive path.
      var winPath = decodeURIComponent(rest.replace(/\//g, '\\'));
      if (host !== '' && !isLocalhost) {
        return '\\\\' + host + winPath;
      }
      // Local paths require a drive letter (winPath is "\C:\..."): the char at
      // index 1 must be a-z/A-Z and index 2 a colon, else the path is not
      // absolute (Node throws ERR_INVALID_FILE_URL_PATH).
      var letter = winPath.charCodeAt(1) | 0x20;
      if (letter < 97 || letter > 122 || winPath.charAt(2) !== ':') {
        var pathErr = new TypeError('File URL path must be absolute');
        pathErr.code = 'ERR_INVALID_FILE_URL_PATH';
        throw pathErr;
      }
      return winPath.slice(1);
    }

    // POSIX: the host must be empty or "localhost"; anything else is rejected.
    if (host !== '' && !isLocalhost) {
      var hostErr = new TypeError(
        'File URL host must be "localhost" or empty on ' + process.platform,
      );
      hostErr.code = 'ERR_INVALID_FILE_URL_HOST';
      throw hostErr;
    }
    return decodeURIComponent(rest);
  }

  module.exports = { fileURLToPath: fileURLToPath };
});
