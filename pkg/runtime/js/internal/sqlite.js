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

  function StatementSync(dbId, stmtId) {
    this._dbId = dbId;
    this._stmtId = stmtId;
  }

  StatementSync.prototype._prime = function (args) {
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
      throw new Error('database is not open');
    }
  };

  DatabaseSync.prototype.exec = function (sql) {
    this._assertOpen();
    native.exec(this._id, String(sql));
  };

  DatabaseSync.prototype.prepare = function (sql) {
    this._assertOpen();
    return new StatementSync(this._id, native.prepare(this._id, String(sql)));
  };

  DatabaseSync.prototype.close = function () {
    if (this._open) {
      native.close(this._id);
      this._open = false;
    }
  };

  module.exports = { DatabaseSync: DatabaseSync, StatementSync: StatementSync };
});
