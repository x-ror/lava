// node:sqlite — synchronous SQLite, modeled on Node 22's node:sqlite. DatabaseSync
// and StatementSync are thin JS wrappers over the native bindings (pkg/runtime/
// sqlite.odin -> pkg/std/sqlite -> libsqlite3). JS holds opaque integer handle ids;
// the native side keeps the real connection/statement objects and closes them when
// the context is torn down.
(function (require, module, exports, native) {
  'use strict';

  if (!native) {
    throw new Error('node:sqlite is unavailable: Lava was built without libsqlite3');
  }

  // This JSC build exposes neither `Symbol.dispose` nor `using` declarations.
  // Define a stable well-known `Symbol.dispose` if it is absent so the dispose
  // methods below are reachable for manual cleanup now (`obj[Symbol.dispose]()`)
  // and participate in `using` automatically once the engine supports it.
  // Idempotent: a real engine/global polyfill takes precedence.
  if (typeof Symbol === 'function' && !Symbol.dispose) {
    try {
      Symbol.dispose = Symbol('Symbol.dispose');
    } catch {
      // Symbol is non-extensible here; dispose-by-symbol is simply unavailable.
    }
  }
  var disposeSymbol = typeof Symbol === 'function' ? Symbol.dispose : null;

  // GC backstops so that wrappers dropped without an explicit close/finalize still
  // release their native handle instead of leaking until context teardown. The
  // held value carries only the integer id (and, for statements, the owning db's
  // live-statement map) so the registry never keeps the wrapper itself alive.
  var hasFinalizationRegistry = typeof FinalizationRegistry === 'function';
  var stmtFinalizers = hasFinalizationRegistry
    ? new FinalizationRegistry(function (held) {
        if (held.stmts[held.stmtId]) {
          native.finalize(held.stmtId);
          delete held.stmts[held.stmtId];
        }
      })
    : null;
  var dbFinalizers = hasFinalizationRegistry
    ? new FinalizationRegistry(function (dbId) {
        // No-op on the native side if the connection was already closed.
        native.close(dbId);
      })
    : null;

  function StatementSync(db, stmtId) {
    this._db = db;
    this._dbId = db._id;
    this._stmtId = stmtId;
    this._finalized = false;
    // When true, INTEGER columns and run()'s changes/lastInsertRowid are returned
    // as BigInt (node:sqlite setReadBigInts). Default false: out-of-range column
    // reads throw ERR_OUT_OF_RANGE rather than silently losing precision.
    this._readBigInts = false;
    // When false (default), a key on a named-parameter object that matches no
    // placeholder throws (node:sqlite setAllowUnknownNamedParameters).
    this._allowUnknownNamedParameters = false;
    // Track the live statement on its database so db.close() can finalize it.
    db._stmts[stmtId] = true;
    if (stmtFinalizers) {
      stmtFinalizers.register(this, { stmtId: stmtId, stmts: db._stmts }, this);
    }
  }

  // Throws like Node when the statement can no longer be used. Closing the
  // database finalizes its statements (see DatabaseSync.close), so a statement
  // whose db is closed reports as finalized too — matching node:sqlite.
  StatementSync.prototype._assertReady = function () {
    if (this._finalized || !this._db._open) {
      var err = new Error('statement has been finalized');
      err.code = 'ERR_INVALID_STATE';
      throw err;
    }
  };

  // _finalize releases the native statement and drops it from the db's live set.
  // Idempotent and safe to call after the owning db has been closed.
  StatementSync.prototype._finalize = function () {
    if (this._finalized) return;
    this._finalized = true;
    if (this._db._stmts[this._stmtId]) {
      native.finalize(this._stmtId);
      delete this._db._stmts[this._stmtId];
    }
    if (stmtFinalizers) stmtFinalizers.unregister(this);
  };

  // Public deterministic cleanup. finalize() releases the native statement now
  // instead of waiting for db.close() or GC; [Symbol.dispose] lets a statement be
  // managed with `using`. (Beyond Node's current node:sqlite surface, which has
  // neither on StatementSync — added for explicit resource management; see #128.)
  StatementSync.prototype.finalize = function () {
    this._finalize();
  };

  // setReadBigInts(enabled): read INTEGER columns (and run()'s numeric results) as
  // BigInt. Matches node:sqlite, which returns undefined.
  StatementSync.prototype.setReadBigInts = function (enabled) {
    this._readBigInts = !!enabled;
  };

  // setAllowUnknownNamedParameters(enabled): when enabled, extra keys on a named-
  // parameter object are ignored instead of throwing. Matches node:sqlite.
  StatementSync.prototype.setAllowUnknownNamedParameters = function (enabled) {
    this._allowUnknownNamedParameters = !!enabled;
  };
  if (disposeSymbol) {
    StatementSync.prototype[disposeSymbol] = StatementSync.prototype._finalize;
  }

  // A leading plain object supplies named parameters (:id / @id / $id); any
  // trailing values fill the statement's anonymous "?" placeholders positionally.
  // A Uint8Array (blob) or null is a value, not a named-parameter bag.
  function isNamedParams(arg) {
    return (
      typeof arg === 'object' && arg !== null && !ArrayBuffer.isView(arg) && !Array.isArray(arg)
    );
  }

  // The signed 64-bit range SQLite INTEGER (and thus a bound BigInt) can hold.
  var I64_MIN = -(2n ** 63n);
  var I64_MAX = 2n ** 63n - 1n;

  // bindOne binds a single value, enforcing node:sqlite's accepted types. Only
  // null, number, string, BigInt, and TypedArray/DataView (blob) are bindable;
  // anything else (undefined, boolean, plain object, symbol, function) throws
  // instead of being silently coerced. BigInt binds as INTEGER when it fits in
  // i64, otherwise throws — Node accepts neither a lossy nor an overflowing bind.
  function bindOne(stmtId, index, value) {
    var t = typeof value;
    if (value === null || t === 'number' || t === 'string') {
      native.bind(stmtId, index, value);
    } else if (t === 'bigint') {
      if (value < I64_MIN || value > I64_MAX) {
        var ov = new TypeError('BigInt value is too large to bind.');
        ov.code = 'ERR_INVALID_ARG_VALUE';
        throw ov;
      }
      native.bindBigInt(stmtId, index, value.toString());
    } else if (ArrayBuffer.isView(value)) {
      // TypedArray/DataView bind as a BLOB. A DataView isn't a JSC "typed array",
      // so view it as a Uint8Array over the same bytes for the native blob path.
      // A bare ArrayBuffer is intentionally NOT accepted here — node:sqlite rejects
      // it too (only views are bindable).
      var view =
        value instanceof DataView
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : value;
      native.bind(stmtId, index, view);
    } else {
      var err = new TypeError('Provided value cannot be bound to SQLite parameter ' + index + '.');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
  }

  StatementSync.prototype._prime = function (args) {
    this._assertReady();
    // Reset clears any prior row cursor and bindings so the statement can be
    // re-run with fresh parameters (Node allows reusing a prepared statement).
    native.reset(this._stmtId);

    var named = null;
    var posStart = 0;
    if (args.length > 0 && isNamedParams(args[0])) {
      named = args[0];
      posStart = 1;
    }

    var count = native.bindParameterCount(this._stmtId);
    var pos = posStart;
    // Names the statement actually declares (sigil stripped), so we can reject any
    // extra key on the named-parameter object below.
    var known = named ? Object.create(null) : null;
    for (var i = 0; i < count; i++) {
      var name = native.bindParameterName(this._stmtId, i + 1);
      if (name) {
        // Strip the leading sigil (":" / "@" / "$") to get the object key.
        var key = name.slice(1);
        if (known) known[key] = true;
        // An unmatched named parameter binds as NULL, matching node:sqlite (an
        // unbound parameter defaults to NULL rather than raising).
        var value = named && Object.prototype.hasOwnProperty.call(named, key) ? named[key] : null;
        bindOne(this._stmtId, i + 1, value);
      } else if (pos < args.length) {
        // Anonymous "?" parameter — take the next positional argument. An
        // explicitly-passed undefined is rejected by bindOne (Node throws).
        bindOne(this._stmtId, i + 1, args[pos++]);
      } else {
        // Fewer positional args than placeholders: the trailing ones bind NULL,
        // matching node:sqlite (which leaves unbound parameters as NULL).
        native.bind(this._stmtId, i + 1, null);
      }
    }
    // A key on the named-parameter object that maps to no placeholder is almost
    // always a typo that would otherwise run with a value silently dropped, so
    // node:sqlite throws ERR_INVALID_STATE unless setAllowUnknownNamedParameters
    // was enabled. (Missing keys are fine — they bind NULL above.)
    if (named && !this._allowUnknownNamedParameters) {
      var keys = Object.keys(named);
      for (var k = 0; k < keys.length; k++) {
        if (!known[keys[k]]) {
          var unknown = new Error("Unknown named parameter '" + keys[k] + "'");
          unknown.code = 'ERR_INVALID_STATE';
          throw unknown;
        }
      }
    }
    // Extra positional args beyond the placeholder count: bind one past the end
    // so SQLite reports "column index out of range" (ERR_SQLITE_ERROR) — the same
    // way node:sqlite surfaces too many parameters.
    if (pos < args.length) {
      bindOne(this._stmtId, count + 1, args[pos]);
    }
  };

  // get(...params) -> first row as an object, or undefined when there are none.
  StatementSync.prototype.get = function () {
    this._prime(arguments);
    if (native.step(this._stmtId, this._dbId) === 0) {
      return native.row(this._stmtId, this._readBigInts);
    }
    return;
  };

  // all(...params) -> array of row objects.
  StatementSync.prototype.all = function () {
    this._prime(arguments);
    var rows = [];
    while (native.step(this._stmtId, this._dbId) === 0) {
      rows.push(native.row(this._stmtId, this._readBigInts));
    }
    return rows;
  };

  // run(...params) -> { changes, lastInsertRowid }.
  StatementSync.prototype.run = function () {
    this._prime(arguments);
    while (native.step(this._stmtId, this._dbId) === 0) {
      // drain any rows a write statement might yield (e.g. RETURNING)
    }
    return {
      changes: native.changes(this._dbId, this._readBigInts),
      lastInsertRowid: native.lastInsertRowid(this._dbId, this._readBigInts),
    };
  };

  // normalizePath resolves the accepted node:sqlite location types to a filesystem
  // path string: a string as-is, a Uint8Array/Buffer decoded as UTF-8 path bytes,
  // and a WHATWG file: URL via node:url. Anything else (including a bare object or
  // undefined) throws ERR_INVALID_ARG_TYPE rather than opening a file named
  // "undefined" (what String(undefined) would produce). The path may not contain a
  // NUL, which would silently truncate the filename.
  function normalizePath(path) {
    var resolved;
    if (typeof path === 'string') {
      resolved = path;
    } else if (path instanceof Uint8Array) {
      resolved = new TextDecoder().decode(path);
    } else if (
      path !== null &&
      typeof path === 'object' &&
      typeof path.href === 'string' &&
      typeof path.protocol === 'string'
    ) {
      // A URL object — only a file: URL names a path (fileURLToPath rejects others).
      resolved = require('node:url').fileURLToPath(path.href);
    } else {
      var e = new TypeError(
        'The "path" argument must be a string, Uint8Array, or URL without null bytes.',
      );
      e.code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    if (resolved.indexOf('\0') !== -1) {
      var nul = new TypeError(
        'The "path" argument must be a string, Uint8Array, or URL without null bytes.',
      );
      nul.code = 'ERR_INVALID_ARG_TYPE';
      throw nul;
    }
    return resolved;
  }

  function DatabaseSync(path) {
    if (!(this instanceof DatabaseSync)) {
      throw new TypeError("Class constructor DatabaseSync cannot be invoked without 'new'");
    }
    this._id = native.open(normalizePath(path));
    this._open = true;
    // Map of live statement id -> true for statements prepared on this connection.
    // Null-proto so a statement id can never collide with an Object.prototype key.
    // (The FinalizationRegistry held value references this object by identity, so
    // it must stay a plain object, not a Set.)
    this._stmts = Object.create(null);
    if (dbFinalizers) dbFinalizers.register(this, this._id, this);
  }

  Object.defineProperty(DatabaseSync.prototype, 'isOpen', {
    get: function () {
      return this._open;
    },
    enumerable: true,
    configurable: true,
  });

  DatabaseSync.prototype._assertOpen = function () {
    if (!this._open) {
      var err = new Error('database is not open');
      err.code = 'ERR_INVALID_STATE';
      throw err;
    }
  };

  DatabaseSync.prototype.exec = function (sql) {
    this._assertOpen();
    native.exec(this._id, String(sql));
  };

  DatabaseSync.prototype.prepare = function (sql) {
    this._assertOpen();
    return new StatementSync(this, native.prepare(this._id, String(sql)));
  };

  DatabaseSync.prototype.close = function () {
    this._assertOpen();
    // Finalize every outstanding statement before closing the connection;
    // sqlite3_close_v2 would otherwise leave the connection a zombie (fd + file
    // locks held) until the last statement is finalized.
    var ids = Object.keys(this._stmts);
    for (var i = 0; i < ids.length; i++) {
      var id = Number(ids[i]);
      native.finalize(id);
      delete this._stmts[id];
    }
    native.close(this._id);
    this._open = false;
    if (dbFinalizers) dbFinalizers.unregister(this);
  };

  // [Symbol.dispose] closes the connection, matching node:sqlite — lets a
  // DatabaseSync be managed with `using`.
  if (disposeSymbol) {
    DatabaseSync.prototype[disposeSymbol] = DatabaseSync.prototype.close;
  }

  module.exports = { DatabaseSync: DatabaseSync, StatementSync: StatementSync };
});
