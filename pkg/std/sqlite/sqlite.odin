package sqlite

Status :: enum {
	Ok,
	Native_SQLite_Unavailable,
	Invalid_Input,
}

Database :: struct {
	path:    string,
	is_open: bool,
}

Result :: struct {
	status:  Status,
	message: string,
}

open_sync :: proc(path: string) -> (Database, Result) {
	if len(path) == 0 {
		return Database{}, Result{
			status = .Invalid_Input,
			message = "missing SQLite database path",
		}
	}

	return Database{path = path}, unavailable()
}

close :: proc(db: ^Database) -> Result {
	db.is_open = false
	return unavailable()
}

exec :: proc(db: ^Database, sql: string) -> Result {
	if len(sql) == 0 {
		return Result{
			status = .Invalid_Input,
			message = "missing SQL",
		}
	}

	return unavailable()
}

unavailable :: proc() -> Result {
	return Result{
		status = .Native_SQLite_Unavailable,
		message = "native SQLite unavailable: install sqlite3 development package",
	}
}

