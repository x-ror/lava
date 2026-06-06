// Native SQLite for Lava's standard library. On Linux/macOS this links the system
// libsqlite3 and exposes a small synchronous Odin API (open / exec / prepare /
// step / column / bind / close) that the runtime's node:sqlite bridge sits on top
// of. On platforms without a linkable libsqlite3 (Windows in CI, where the runtime
// is type-checked/codegen-only) the same API compiles but reports
// `Native_SQLite_Unavailable`.
package sqlite

import "core:c"
import "core:strings"

SQLITE_AVAILABLE :: ODIN_OS == .Linux || ODIN_OS == .Darwin

Status :: enum {
	Ok,
	Native_SQLite_Unavailable,
	Invalid_Input,
	Error,
}

// Result carries a status and a STATIC description only. Dynamic SQLite error
// text is fetched separately via `errmsg(db)` so message ownership stays simple
// (callers never free Result.message).
Result :: struct {
	status:  Status,
	message: string,
}

Database :: struct {
	handle:  rawptr, // sqlite3*
	is_open: bool,
}

Statement :: struct {
	handle: rawptr, // sqlite3_stmt*
}

Step_Result :: enum {
	Row,
	Done,
	Error,
}

Column_Type :: enum {
	Integer,
	Float,
	Text,
	Blob,
	Null,
}

unavailable :: proc() -> Result {
	return Result {
		status = .Native_SQLite_Unavailable,
		message = "native SQLite unavailable: install the sqlite3 development package",
	}
}

when SQLITE_AVAILABLE {
	foreign import sqlite_lib "system:sqlite3"

	SQLITE_OK :: 0
	SQLITE_ROW :: 100
	SQLITE_DONE :: 101
	SQLITE_INTEGER :: 1
	SQLITE_FLOAT :: 2
	SQLITE_TEXT :: 3
	SQLITE_BLOB :: 4
	SQLITE_NULL_TYPE :: 5

	@(default_calling_convention = "c", link_prefix = "")
	foreign sqlite_lib {
		sqlite3_open :: proc(filename: cstring, ppDb: ^rawptr) -> c.int ---
		sqlite3_close :: proc(db: rawptr) -> c.int ---
		sqlite3_errmsg :: proc(db: rawptr) -> cstring ---
		sqlite3_exec :: proc(db: rawptr, sql: cstring, cb: rawptr, arg: rawptr, errmsg: ^cstring) -> c.int ---
		sqlite3_prepare_v2 :: proc(db: rawptr, zSql: cstring, nByte: c.int, ppStmt: ^rawptr, pzTail: ^cstring) -> c.int ---
		sqlite3_step :: proc(stmt: rawptr) -> c.int ---
		sqlite3_reset :: proc(stmt: rawptr) -> c.int ---
		sqlite3_clear_bindings :: proc(stmt: rawptr) -> c.int ---
		sqlite3_finalize :: proc(stmt: rawptr) -> c.int ---
		sqlite3_column_count :: proc(stmt: rawptr) -> c.int ---
		sqlite3_column_name :: proc(stmt: rawptr, i: c.int) -> cstring ---
		sqlite3_column_type :: proc(stmt: rawptr, i: c.int) -> c.int ---
		sqlite3_column_int64 :: proc(stmt: rawptr, i: c.int) -> i64 ---
		sqlite3_column_double :: proc(stmt: rawptr, i: c.int) -> f64 ---
		sqlite3_column_text :: proc(stmt: rawptr, i: c.int) -> [^]u8 ---
		sqlite3_column_bytes :: proc(stmt: rawptr, i: c.int) -> c.int ---
		sqlite3_column_blob :: proc(stmt: rawptr, i: c.int) -> rawptr ---
		sqlite3_bind_text :: proc(stmt: rawptr, i: c.int, text: cstring, n: c.int, destroy: rawptr) -> c.int ---
		sqlite3_bind_int64 :: proc(stmt: rawptr, i: c.int, v: i64) -> c.int ---
		sqlite3_bind_double :: proc(stmt: rawptr, i: c.int, v: f64) -> c.int ---
		sqlite3_bind_null :: proc(stmt: rawptr, i: c.int) -> c.int ---
		sqlite3_bind_blob :: proc(stmt: rawptr, i: c.int, p: rawptr, n: c.int, destroy: rawptr) -> c.int ---
		sqlite3_bind_parameter_count :: proc(stmt: rawptr) -> c.int ---
		sqlite3_changes :: proc(db: rawptr) -> c.int ---
		sqlite3_last_insert_rowid :: proc(db: rawptr) -> i64 ---
	}

	// (void*)-1: tells SQLite to copy bound text/blob immediately so the caller
	// need not keep the buffer alive.
	sqlite_transient :: proc "contextless" () -> rawptr {
		return cast(rawptr)(~uintptr(0))
	}
}

// open opens (or creates) the database at `path` (":memory:" for an in-memory DB).
open :: proc(path: string) -> (Database, Result) {
	if len(path) == 0 {
		return Database{}, Result{status = .Invalid_Input, message = "missing SQLite database path"}
	}
	when !SQLITE_AVAILABLE {
		return Database{}, unavailable()
	} else {
		cpath := strings.clone_to_cstring(path, context.temp_allocator)
		handle: rawptr
		rc := sqlite3_open(cpath, &handle)
		if rc != SQLITE_OK {
			if handle != nil do sqlite3_close(handle)
			return Database{}, Result{status = .Error, message = "could not open database"}
		}
		return Database{handle = handle, is_open = true}, Result{status = .Ok}
	}
}

close :: proc(db: ^Database) {
	when SQLITE_AVAILABLE {
		if db != nil && db.handle != nil {
			sqlite3_close(db.handle)
		}
	}
	if db != nil {
		db.handle = nil
		db.is_open = false
	}
}

exec :: proc(db: ^Database, sql: string) -> Result {
	if db == nil || !db.is_open {
		return Result{status = .Invalid_Input, message = "database is not open"}
	}
	if len(sql) == 0 {
		return Result{status = .Invalid_Input, message = "missing SQL"}
	}
	when !SQLITE_AVAILABLE {
		return unavailable()
	} else {
		csql := strings.clone_to_cstring(sql, context.temp_allocator)
		rc := sqlite3_exec(db.handle, csql, nil, nil, nil)
		if rc != SQLITE_OK {
			return Result{status = .Error, message = "exec failed"}
		}
		return Result{status = .Ok}
	}
}

prepare :: proc(db: ^Database, sql: string) -> (Statement, Result) {
	if db == nil || !db.is_open {
		return Statement{}, Result{status = .Invalid_Input, message = "database is not open"}
	}
	when !SQLITE_AVAILABLE {
		return Statement{}, unavailable()
	} else {
		csql := strings.clone_to_cstring(sql, context.temp_allocator)
		handle: rawptr
		rc := sqlite3_prepare_v2(db.handle, csql, -1, &handle, nil)
		if rc != SQLITE_OK || handle == nil {
			return Statement{}, Result{status = .Error, message = "prepare failed"}
		}
		return Statement{handle = handle}, Result{status = .Ok}
	}
}

step :: proc(stmt: ^Statement) -> Step_Result {
	when !SQLITE_AVAILABLE {
		return .Error
	} else {
		if stmt == nil || stmt.handle == nil do return .Error
		rc := sqlite3_step(stmt.handle)
		switch rc {
		case SQLITE_ROW:
			return .Row
		case SQLITE_DONE:
			return .Done
		}
		return .Error
	}
}

reset :: proc(stmt: ^Statement) {
	when SQLITE_AVAILABLE {
		if stmt != nil && stmt.handle != nil {
			sqlite3_reset(stmt.handle)
			sqlite3_clear_bindings(stmt.handle)
		}
	}
}

finalize :: proc(stmt: ^Statement) {
	when SQLITE_AVAILABLE {
		if stmt != nil && stmt.handle != nil {
			sqlite3_finalize(stmt.handle)
		}
	}
	if stmt != nil do stmt.handle = nil
}

column_count :: proc(stmt: ^Statement) -> int {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		if stmt == nil || stmt.handle == nil do return 0
		return int(sqlite3_column_count(stmt.handle))
	}
}

// column_name returns a borrowed UTF-8 name valid until the next step/reset/finalize.
column_name :: proc(stmt: ^Statement, i: int) -> string {
	when !SQLITE_AVAILABLE {
		return ""
	} else {
		if stmt == nil || stmt.handle == nil do return ""
		return string(sqlite3_column_name(stmt.handle, c.int(i)))
	}
}

column_type :: proc(stmt: ^Statement, i: int) -> Column_Type {
	when !SQLITE_AVAILABLE {
		return .Null
	} else {
		if stmt == nil || stmt.handle == nil do return .Null
		switch sqlite3_column_type(stmt.handle, c.int(i)) {
		case SQLITE_INTEGER:
			return .Integer
		case SQLITE_FLOAT:
			return .Float
		case SQLITE_TEXT:
			return .Text
		case SQLITE_BLOB:
			return .Blob
		}
		return .Null
	}
}

column_int :: proc(stmt: ^Statement, i: int) -> i64 {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		return sqlite3_column_int64(stmt.handle, c.int(i))
	}
}

column_double :: proc(stmt: ^Statement, i: int) -> f64 {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		return sqlite3_column_double(stmt.handle, c.int(i))
	}
}

// column_text returns a borrowed UTF-8 string valid until the next step/reset/finalize.
column_text :: proc(stmt: ^Statement, i: int) -> string {
	when !SQLITE_AVAILABLE {
		return ""
	} else {
		ptr := sqlite3_column_text(stmt.handle, c.int(i))
		if ptr == nil do return ""
		n := int(sqlite3_column_bytes(stmt.handle, c.int(i)))
		return string(ptr[:n])
	}
}

// column_blob returns borrowed bytes valid until the next step/reset/finalize.
column_blob :: proc(stmt: ^Statement, i: int) -> []byte {
	when !SQLITE_AVAILABLE {
		return nil
	} else {
		ptr := sqlite3_column_blob(stmt.handle, c.int(i))
		n := int(sqlite3_column_bytes(stmt.handle, c.int(i)))
		if ptr == nil || n == 0 do return nil
		return (cast([^]byte)ptr)[:n]
	}
}

bind_parameter_count :: proc(stmt: ^Statement) -> int {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		if stmt == nil || stmt.handle == nil do return 0
		return int(sqlite3_bind_parameter_count(stmt.handle))
	}
}

// Bind parameters are 1-based, matching the SQLite C API.
bind_int :: proc(stmt: ^Statement, index: int, value: i64) {
	when SQLITE_AVAILABLE {
		sqlite3_bind_int64(stmt.handle, c.int(index), value)
	}
}

bind_double :: proc(stmt: ^Statement, index: int, value: f64) {
	when SQLITE_AVAILABLE {
		sqlite3_bind_double(stmt.handle, c.int(index), value)
	}
}

bind_null :: proc(stmt: ^Statement, index: int) {
	when SQLITE_AVAILABLE {
		sqlite3_bind_null(stmt.handle, c.int(index))
	}
}

bind_text :: proc(stmt: ^Statement, index: int, value: string) {
	when SQLITE_AVAILABLE {
		cval := strings.clone_to_cstring(value, context.temp_allocator)
		sqlite3_bind_text(stmt.handle, c.int(index), cval, c.int(len(value)), sqlite_transient())
	}
}

bind_blob :: proc(stmt: ^Statement, index: int, value: []byte) {
	when SQLITE_AVAILABLE {
		ptr := len(value) > 0 ? raw_data(value) : nil
		sqlite3_bind_blob(stmt.handle, c.int(index), ptr, c.int(len(value)), sqlite_transient())
	}
}

changes :: proc(db: ^Database) -> i64 {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		if db == nil || db.handle == nil do return 0
		return i64(sqlite3_changes(db.handle))
	}
}

last_insert_rowid :: proc(db: ^Database) -> i64 {
	when !SQLITE_AVAILABLE {
		return 0
	} else {
		if db == nil || db.handle == nil do return 0
		return sqlite3_last_insert_rowid(db.handle)
	}
}

// errmsg returns the most recent error text, cloned into `allocator` (caller frees).
errmsg :: proc(db: ^Database, allocator := context.allocator) -> string {
	when !SQLITE_AVAILABLE {
		return ""
	} else {
		if db == nil || db.handle == nil do return ""
		msg := sqlite3_errmsg(db.handle)
		if msg == nil do return ""
		cloned, _ := strings.clone(string(msg), allocator)
		return cloned
	}
}
