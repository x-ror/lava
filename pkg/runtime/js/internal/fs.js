// node:fs — a thin JS layer over the Odin-backed primitives.
//
// WHY THIS FILE EXISTS. Until now `node:fs` was assembled natively in require.odin and
// was the one built-in with no JS layer at all (ARCHITECTURE.md §3.3 names it the
// native-direct outlier). That cost a Node-contract bug that survived a year: the read
// primitives hand back whatever `make_uint8_array` produced — a plain `Uint8Array` — where
// node returns a **Buffer**. The bytes were always right; only the prototype was wrong,
// and the failure mode is the bad one. `Uint8Array.prototype.toString` ignores its
// argument, so `fs.readFileSync(p).toString('hex')` returned `"116,121"` instead of
// `"7479"`: plausible-looking output, no throw.
//
// Tagging belongs here rather than in the native. The native would have to hold a
// protected `Buffer.prototype` per context and sweep it from destroy_runtime_state like
// every other JSC-handle cache (CLAUDE.md §4); in JS it is one `Buffer.from` over the same
// backing store. See issue #329, and #242 for the rest of the normalization this layer
// makes possible (writeFile encoding/flag/mode, SharedArrayBuffer views, a real DataView
// brand check).
//
// ZERO COPY. `Buffer.from(arrayBuffer, byteOffset, length)` shares memory by spec — it
// does NOT copy, verified on node 24.18.1 and here (mutating the Buffer is visible through
// the original view). A copy would be a per-file-size regression on the hottest fs call
// there is, and CLAUDE.md ranks memory second only to conformance.
//
// Everything else is re-exported by identity: same function objects the native branch
// installed, so nothing about the other 13 entry points changes.
(function (require, module, exports, native) {
  'use strict';

  var P = require('primordials');
  var TypeErrorG = P.TypeError;
  var StringG = P.String;
  var TypedArrayPrototypeGetBuffer = P.TypedArrayPrototypeGetBuffer;
  var TypedArrayPrototypeGetByteOffset = P.TypedArrayPrototypeGetByteOffset;
  var TypedArrayPrototypeGetByteLength = P.TypedArrayPrototypeGetByteLength;

  // `Buffer` is a module export, not an intrinsic, so it is not in the primordials table.
  // Captured here at module eval — buffer.js is eager-loaded by the loader well before
  // anything can require('fs'), and a capture at eval is what §5 asks for anyway.
  var BufferG = require('buffer').Buffer;
  var BufferFrom = BufferG.from;
  var BufferIsEncoding = BufferG.isEncoding;
  var BufferPrototypeToString = P.uncurryThis(BufferG.prototype.toString);

  // Node renders the received value inline in the ERR_INVALID_ARG_TYPE message —
  // `Received type number (123)`. Only the primitives can reach here (an object takes the
  // encoding branch), so this stays a switch on typeof rather than pulling in inspect.
  function inspectReceived(value) {
    if (typeof value === 'string') return quote(value);
    if (typeof value === 'bigint') return StringG(value) + 'n';
    // StringG() is the one conversion that accepts a symbol; `'' + sym` throws.
    return StringG(value);
  }
  function quote(value) {
    return "'" + value + "'";
  }

  /**
   * Re-tags a native read result as a Buffer, sharing its backing store.
   * @param {*} value Whatever the native returned — a Uint8Array for a binary read, a
   *                  string when an encoding was supplied, or an error/undefined.
   * @returns {*} A Buffer for the Uint8Array case; `value` untouched otherwise.
   * @node readFileSync/readFile return a Buffer with no encoding and a string with one
   *       (verified on node 24.18.1, including `{encoding: null}` -> Buffer).
   * @deviates none
   */
  function asBuffer(value) {
    // A string (an encoding was supplied) or a non-view passes straight through: the
    // native decides which shape to return, and this layer must not second-guess it.
    if (typeof value !== 'object' || value === null) return value;
    // Read the window through the captured getters rather than `.buffer`/`.byteOffset`
    // (§5's accessor class). The value comes from our own native here, so this is
    // belt-and-braces — but the same helper is where #242's user-supplied views will
    // land, and a live read there is the exact bug reverted in #326.
    return BufferFrom(
      TypedArrayPrototypeGetBuffer(value),
      TypedArrayPrototypeGetByteOffset(value),
      TypedArrayPrototypeGetByteLength(value),
    );
  }

  /**
   * Extracts and validates the encoding from a read `options` argument.
   * @param {string|{encoding?: string|null}|null|undefined} options
   * @returns {string|null} The encoding name, or null for a binary (Buffer) read.
   * @throws {TypeError} ERR_INVALID_ARG_TYPE — options is neither a string nor an object.
   * @throws {TypeError} ERR_INVALID_ARG_VALUE — the encoding name is not recognized.
   * @node Messages verified against node 24.18.1:
   *       `readFileSync(p, 123)` -> 'The "options" argument must be one of type string or
   *       object. Received type number (123)'; `readFileSync(p, 'bogus')` -> "The argument
   *       'encoding' is invalid encoding. Received 'bogus'". `{}`, `null` and `undefined`
   *       all mean binary.
   * @deviates none
   */
  function readEncoding(options) {
    if (options === null || options === undefined) return null;
    var encoding;
    if (typeof options === 'string') {
      encoding = options;
    } else if (typeof options === 'object') {
      encoding = options.encoding;
      if (encoding === null || encoding === undefined) return null;
    } else {
      var err = new TypeErrorG(
        'The "options" argument must be one of type string or object. Received type ' +
          typeof options +
          ' (' +
          inspectReceived(options) +
          ')',
      );
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (!BufferIsEncoding(encoding)) {
      var e2 = new TypeErrorG(
        "The argument 'encoding' is invalid encoding. Received " + quote(encoding),
      );
      e2.code = 'ERR_INVALID_ARG_VALUE';
      throw e2;
    }
    return encoding;
  }

  // Decoding happens HERE, not in the native, and that is the point of routing reads
  // through this layer at all. The native ignored the encoding argument outright — it
  // decoded everything as UTF-8, so `readFileSync(p, 'hex')` returned the file's text
  // instead of its hex — and its UTF-8 conversion returned an EMPTY STRING for input it
  // could not decode, where node substitutes U+FFFD. Buffer's codecs already handle every
  // encoding node accepts, lossily and correctly, and are covered by the buffer oracle
  // cases; asking the native for bytes and decoding here reuses all of that and deletes
  // the second implementation rather than fixing it twice.
  function decode(bytes, encoding) {
    var buf = asBuffer(bytes);
    return encoding === null ? buf : BufferPrototypeToString(buf, encoding);
  }

  function readFileSync(path, options) {
    var encoding = readEncoding(options);
    // Always request bytes: the native's string path is the one described above.
    return decode(native.readFileSync(path), encoding);
  }

  function readFile(path, options, callback) {
    var cb = callback;
    var opts = options;
    if (typeof opts === 'function') {
      cb = opts;
      opts = null;
    }
    // Validate before dispatching, as node does — a bad encoding throws synchronously
    // rather than surfacing in the callback.
    var encoding = readEncoding(opts);
    return native.readFile(path, function (err, data) {
      if (err) {
        cb(err, data);
        return;
      }
      cb(null, decode(data, encoding));
    });
  }

  exports.readFileSync = readFileSync;
  exports.readFile = readFile;

  // The remaining primitives are re-exported by identity — same function objects, so
  // `.name`, `.length` and object identity are whatever the native installed, exactly as
  // before this layer existed. Listed explicitly rather than copied in a loop so adding a
  // native without deciding whether it needs normalization is a visible edit here.
  var PASSTHROUGH = [
    'writeFile',
    'writeFileSync',
    'openSync',
    'closeSync',
    'existsSync',
    'mkdirSync',
    'mkdtempSync',
    'rmSync',
    'rmdirSync',
    'unlinkSync',
    'renameSync',
    'statSync',
    'readdirSync',
  ];
  for (var i = 0; i < PASSTHROUGH.length; i++) {
    var name = PASSTHROUGH[i];
    // Plain assignment, not a copied descriptor: the native installs these as ordinary
    // writable/enumerable/configurable properties and node's fs exports are the same.
    exports[name] = native[name];
  }

  // `fs.promises` is deliberately NOT defined here. It is missing either way, and a
  // throwing getter would be worse than the absence: `if (fs.promises)` is ordinary
  // feature detection, and it must stay falsy rather than throw.
  //
  // exports is left mutable — node's fs module is not frozen, and monkey-patching it
  // (test doubles, instrumentation) is common enough in the ecosystem that freezing
  // would itself be a deviation.
  module.exports = exports;
});
