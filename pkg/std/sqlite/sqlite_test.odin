package sqlite

import "core:testing"

// Mirrors how the runtime bridge stores handles: heap-allocated structs reached
// through a map[u64]rawptr, with bind happening on the looked-up pointer.
@(test)
bridge_pattern_bind :: proc(t: ^testing.T) {
	when !SQLITE_AVAILABLE {
		return
	}

	dbs := make(map[u64]rawptr)
	stmts := make(map[u64]rawptr)
	defer delete(dbs)
	defer delete(stmts)

	db := new(Database)
	res: Result
	db^, res = open(":memory:")
	testing.expect_value(t, res.status, Status.Ok)
	dbs[1] = cast(rawptr)db

	got_db := cast(^Database)dbs[1]
	stmt := new(Statement)
	stmt^, res = prepare(got_db, "SELECT ? AS v")
	testing.expect_value(t, res.status, Status.Ok)
	stmts[2] = cast(rawptr)stmt

	got_stmt := cast(^Statement)stmts[2]
	bind_int(got_stmt, 1, 42)
	testing.expect_value(t, step(got_stmt), Step_Result.Row)
	testing.expect_value(t, column_type(got_stmt, 0), Column_Type.Integer)
	testing.expect_value(t, column_int(got_stmt, 0), i64(42))

	finalize(got_stmt)
	free(stmt)
	close(got_db)
	free(db)
}

@(test)
in_memory_roundtrip :: proc(t: ^testing.T) {
	when !SQLITE_AVAILABLE {
		return
	}

	db, open_res := open(":memory:")
	testing.expect_value(t, open_res.status, Status.Ok)
	testing.expect(t, db.is_open)
	defer close(&db)

	exec_res := exec(
		&db,
		"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users (name) VALUES ('Ada');",
	)
	testing.expect_value(t, exec_res.status, Status.Ok)
	testing.expect_value(t, changes(&db), i64(1))
	testing.expect_value(t, last_insert_rowid(&db), i64(1))

	stmt, prep_res := prepare(&db, "SELECT id, name FROM users WHERE name = ?")
	testing.expect_value(t, prep_res.status, Status.Ok)
	defer finalize(&stmt)
	testing.expect_value(t, bind_parameter_count(&stmt), 1)

	bind_text(&stmt, 1, "Ada")
	testing.expect_value(t, step(&stmt), Step_Result.Row)
	testing.expect_value(t, column_count(&stmt), 2)
	testing.expect_value(t, column_type(&stmt, 0), Column_Type.Integer)
	testing.expect_value(t, column_int(&stmt, 0), i64(1))
	testing.expect_value(t, column_type(&stmt, 1), Column_Type.Text)
	testing.expect_value(t, column_text(&stmt, 1), "Ada")
	testing.expect_value(t, column_name(&stmt, 1), "name")
	testing.expect_value(t, step(&stmt), Step_Result.Done)
}
