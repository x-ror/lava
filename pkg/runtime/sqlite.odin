package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"
import sqlite "lava:pkg/std/sqlite"

// node:sqlite bridge. js/internal/sqlite.js implements the DatabaseSync /
// StatementSync classes on top of these native primitives; the heavy lifting
// (the libsqlite3 calls) lives in pkg/std/sqlite. JS holds opaque integer handle
// ids; the real ^sqlite.Database / ^sqlite.Statement live in the per-context
// registries on Runtime_State, so they are closed/freed when the context is torn
// down even if user code forgets to call db.close().

// make_sqlite_bindings builds the `native` object handed to js/internal/sqlite.js.
make_sqlite_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "open", sqlite_open_cb)
	inject_native_function(ctx, bindings, "close", sqlite_close_cb)
	inject_native_function(ctx, bindings, "exec", sqlite_exec_cb)
	inject_native_function(ctx, bindings, "prepare", sqlite_prepare_cb)
	inject_native_function(ctx, bindings, "finalize", sqlite_finalize_cb)
	inject_native_function(ctx, bindings, "reset", sqlite_reset_cb)
	inject_native_function(ctx, bindings, "bind", sqlite_bind_cb)
	inject_native_function(ctx, bindings, "bindParameterCount", sqlite_bind_parameter_count_cb)
	inject_native_function(ctx, bindings, "step", sqlite_step_cb)
	inject_native_function(ctx, bindings, "row", sqlite_row_cb)
	inject_native_function(ctx, bindings, "changes", sqlite_changes_cb)
	inject_native_function(ctx, bindings, "lastInsertRowid", sqlite_last_insert_rowid_cb)
	return bindings
}

// sqlite_destroy_state finalizes every open statement and database for the context.
sqlite_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	for _, ptr in state.sqlite_stmts {
		stmt := cast(^sqlite.Statement)ptr
		sqlite.finalize(stmt)
		free(stmt)
	}
	for _, ptr in state.sqlite_dbs {
		db := cast(^sqlite.Database)ptr
		sqlite.close(db)
		free(db)
	}
	delete(state.sqlite_dbs)
	delete(state.sqlite_stmts)
}

// --- registry helpers ---

sqlite_get_db :: proc(state: ^Runtime_State, id: u64) -> ^sqlite.Database {
	if state == nil do return nil
	if ptr, ok := state.sqlite_dbs[id]; ok do return cast(^sqlite.Database)ptr
	return nil
}

sqlite_get_stmt :: proc(state: ^Runtime_State, id: u64) -> ^sqlite.Statement {
	if state == nil do return nil
	if ptr, ok := state.sqlite_stmts[id]; ok do return cast(^sqlite.Statement)ptr
	return nil
}

sqlite_arg_id :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> u64 {
	return u64(jsc.JSValueToNumber(ctx, value, nil))
}

// --- native callbacks ---

sqlite_open_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite open requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	if state == nil do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	path, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path, context.allocator)

	db := new(sqlite.Database)
	result: sqlite.Result
	db^, result = sqlite.open(path)
	if result.status != .Ok {
		free(db)
		if exception != nil do exception^ = make_js_error(ctx, result.message)
		return jsc.JSValueMakeUndefined(ctx)
	}

	id := state.next_sqlite_id
	state.next_sqlite_id += 1
	state.sqlite_dbs[id] = cast(rawptr)db
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

sqlite_close_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	db := sqlite_get_db(state, id)
	if db != nil {
		sqlite.close(db)
		free(db)
		delete_key(&state.sqlite_dbs, id)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_exec_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite exec requires a handle and SQL")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	db := sqlite_get_db(state, sqlite_arg_id(ctx, args[0]))
	if db == nil {
		if exception != nil do exception^ = make_js_error(ctx, "database is not open")
		return jsc.JSValueMakeUndefined(ctx)
	}
	sql, sql_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if sql_alloc do delete(sql, context.allocator)

	result := sqlite.exec(db, sql)
	if result.status != .Ok && exception != nil {
		exception^ = make_js_error(ctx, sqlite_error_text(db, result))
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_prepare_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite prepare requires a handle and SQL")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	db := sqlite_get_db(state, sqlite_arg_id(ctx, args[0]))
	if db == nil {
		if exception != nil do exception^ = make_js_error(ctx, "database is not open")
		return jsc.JSValueMakeUndefined(ctx)
	}
	sql, sql_alloc := jsc_value_to_string_or_default(ctx, args[1])
	defer if sql_alloc do delete(sql, context.allocator)

	stmt := new(sqlite.Statement)
	result: sqlite.Result
	stmt^, result = sqlite.prepare(db, sql)
	if result.status != .Ok {
		free(stmt)
		if exception != nil do exception^ = make_js_error(ctx, sqlite_error_text(db, result))
		return jsc.JSValueMakeUndefined(ctx)
	}

	id := state.next_sqlite_id
	state.next_sqlite_id += 1
	state.sqlite_stmts[id] = cast(rawptr)stmt
	return jsc.JSValueMakeNumber(ctx, f64(id))
}

sqlite_finalize_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	stmt := sqlite_get_stmt(state, id)
	if stmt != nil {
		sqlite.finalize(stmt)
		free(stmt)
		delete_key(&state.sqlite_stmts, id)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_reset_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt != nil do sqlite.reset(stmt)
	return jsc.JSValueMakeUndefined(ctx)
}

sqlite_bind_parameter_count_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt == nil do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(sqlite.bind_parameter_count(stmt)))
}

// sqlite_bind_cb(stmtId, index, value): binds one 1-based parameter, inferring the
// SQLite type from the JS value (null/number/string/Uint8Array).
sqlite_bind_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 {
		if exception != nil do exception^ = make_js_error(ctx, "sqlite bind requires handle, index and value")
		return jsc.JSValueMakeUndefined(ctx)
	}
	state := get_state_from_ctx(ctx)
	args := arguments[:int(argument_count)]
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, args[0]))
	if stmt == nil {
		if exception != nil do exception^ = make_js_error(ctx, "statement is not prepared")
		return jsc.JSValueMakeUndefined(ctx)
	}
	index := int(jsc.JSValueToNumber(ctx, args[1], nil))
	value := args[2]

	// Classify the value up front. (The JSValueType is read once via JSValueGetType
	// rather than via a chain of JSValueIs* calls.)
	#partial switch jsc.JSValueGetType(ctx, value) {
	case .Null, .Undefined:
		sqlite.bind_null(stmt, index)
	case .Boolean:
		sqlite.bind_int(stmt, index, bool(jsc.JSValueToBoolean(ctx, value)) ? 1 : 0)
	case .Number:
		n := jsc.JSValueToNumber(ctx, value, nil)
		// Whole numbers within the safe-integer range bind as INTEGER, else REAL.
		if n == f64(i64(n)) && n >= -9007199254740992.0 && n <= 9007199254740992.0 {
			sqlite.bind_int(stmt, index, i64(n))
		} else {
			sqlite.bind_double(stmt, index, n)
		}
	case .String:
		s, alloc := jsc_value_to_string_or_default(ctx, value)
		defer if alloc do delete(s, context.allocator)
		sqlite.bind_text(stmt, index, s)
	case .Object:
		if jsc.JSValueGetTypedArrayType(ctx, value, nil) != .None {
			obj := cast(jsc.JSObjectRef)value
			ptr := jsc.JSObjectGetTypedArrayBytesPtr(ctx, obj, nil)
			n := int(jsc.JSObjectGetTypedArrayByteLength(ctx, obj, nil))
			bytes: []byte = nil
			if ptr != nil && n > 0 do bytes = (cast([^]byte)ptr)[:n]
			sqlite.bind_blob(stmt, index, bytes)
		} else if exception != nil {
			exception^ = make_js_error(ctx, "unsupported SQLite bind value type")
		}
	case:
		if exception != nil do exception^ = make_js_error(ctx, "unsupported SQLite bind value type")
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// sqlite_step_cb(stmtId) -> 0 (row available) | 1 (done). Throws on error.
sqlite_step_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 1)
	state := get_state_from_ctx(ctx)
	id := sqlite_arg_id(ctx, arguments[0])
	stmt := sqlite_get_stmt(state, id)
	if stmt == nil {
		if exception != nil do exception^ = make_js_error(ctx, "statement is not prepared")
		return jsc.JSValueMakeNumber(ctx, 1)
	}
	switch sqlite.step(stmt) {
	case .Row:
		return jsc.JSValueMakeNumber(ctx, 0)
	case .Done:
		return jsc.JSValueMakeNumber(ctx, 1)
	case .Error:
		// The owning db id is passed as the 2nd arg so we can surface its errmsg.
		db := argument_count >= 2 ? sqlite_get_db(state, sqlite_arg_id(ctx, arguments[1])) : nil
		if exception != nil {
			msg := db != nil ? sqlite.errmsg(db, context.temp_allocator) : "sqlite step failed"
			if len(msg) == 0 do msg = "sqlite step failed"
			exception^ = make_js_error(ctx, msg)
		}
		return jsc.JSValueMakeNumber(ctx, 1)
	}
	return jsc.JSValueMakeNumber(ctx, 1)
}

// sqlite_row_cb(stmtId) builds the current row as a { columnName: value } object,
// coercing each column to the matching JS type.
sqlite_row_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)
	state := get_state_from_ctx(ctx)
	stmt := sqlite_get_stmt(state, sqlite_arg_id(ctx, arguments[0]))
	if stmt == nil do return jsc.JSValueMakeUndefined(ctx)

	row := jsc.JSObjectMake(ctx, nil, nil)
	count := sqlite.column_count(stmt)
	for i in 0 ..< count {
		name := sqlite.column_name(stmt, i)
		value: jsc.JSValueRef
		switch sqlite.column_type(stmt, i) {
		case .Integer:
			value = jsc.JSValueMakeNumber(ctx, f64(sqlite.column_int(stmt, i)))
		case .Float:
			value = jsc.JSValueMakeNumber(ctx, sqlite.column_double(stmt, i))
		case .Text:
			value = js_string_value(ctx, sqlite.column_text(stmt, i))
		case .Blob:
			value = sqlite_blob_to_value(ctx, sqlite.column_blob(stmt, i))
		case .Null:
			value = jsc.JSValueMakeNull(ctx)
		}
		set_named(ctx, row, name, value)
	}
	return cast(jsc.JSValueRef)row
}

sqlite_changes_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	db := sqlite_get_db(state, sqlite_arg_id(ctx, arguments[0]))
	if db == nil do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(sqlite.changes(db)))
}

sqlite_last_insert_rowid_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeNumber(ctx, 0)
	state := get_state_from_ctx(ctx)
	db := sqlite_get_db(state, sqlite_arg_id(ctx, arguments[0]))
	if db == nil do return jsc.JSValueMakeNumber(ctx, 0)
	return jsc.JSValueMakeNumber(ctx, f64(sqlite.last_insert_rowid(db)))
}

// --- helpers ---

// sqlite_error_text returns the live SQLite error string when available, falling
// back to the Result's static message. The returned string is freed before return
// (make_js_error copies it into the JS string).
sqlite_error_text :: proc(db: ^sqlite.Database, result: sqlite.Result) -> string {
	detail := sqlite.errmsg(db, context.temp_allocator)
	if len(detail) > 0 do return detail
	return result.message
}

sqlite_blob_to_value :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	// Copy into a buffer JSC owns (freed by fs_buffer_deallocator on collection);
	// sqlite's blob pointer is only valid until the next step/reset/finalize.
	n := len(data)
	buf := make([]byte, n)
	if n > 0 do copy(buf, data)
	array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
		ctx,
		.Uint8Array,
		raw_data(buf),
		c.size_t(n),
		fs_buffer_deallocator,
		nil,
		nil,
	)
	return cast(jsc.JSValueRef)array
}
