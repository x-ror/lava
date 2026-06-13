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

  StatementSync.prototype._prime = function (args) {
    this._assertReady();
    // Reset clears any prior row cursor and bindings so the statement can be
    // re-run with fresh parameters (Node allows reusing a prepared statement).
    native.reset(this._stmtId);
    var count = native.bindParameterCount(this._stmtId);
    for (var i = 0; i < count; i++) {
      native.bind(this._stmtId, i + 1, args[i]);
    }
  };

  // get(...params) -> first row as an object, or undefined when there are none.
  StatementSync.prototype.get = function () {
    this._prime(arguments);
    if (native.step(this._stmtId, this._dbId) === 0) {
      return native.row(this._stmtId);
    }
    return undefined;
  };

  // all(...params) -> array of row objects.
  StatementSync.prototype.all = function () {
    this._prime(arguments);
    var rows = [];
    while (native.step(this._stmtId, this._dbId) === 0) {
      rows.push(native.row(this._stmtId));
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
      changes: native.changes(this._dbId),
      lastInsertRowid: native.lastInsertRowid(this._dbId),
    };
  };

  function DatabaseSync(path) {
    if (!(this instanceof DatabaseSync)) {
      throw new TypeError("Class constructor DatabaseSync cannot be invoked without 'new'");
    }
    this._id = native.open(String(path));
    this._open = true;
    // Map of live statement id -> true for statements prepared on this connection.
    this._stmts = {};
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

  module.exports = { DatabaseSync: DatabaseSync, StatementSync: StatementSync };
});
