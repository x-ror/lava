package lava_runtime

import "base:runtime"
import "core:io"
import "core:c"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:time"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

fs_read_file_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	data, read_err := os.read_entire_file(path_str, context.allocator)
	if read_err != os.ERROR_NONE {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(read_err)
			exception^ = fs_make_error(ctx, code, "open", path_str, errno_val)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	// With an explicit encoding (readFileSync(path, 'utf8') or {encoding:'utf8'})
	// Node returns a string; with no encoding it returns a Buffer. We model the
	// latter as a Uint8Array so binary data survives intact.
	as_string := false
	if argument_count >= 2 {
		opt := args[1]
		if jsc.JSValueIsString(ctx, opt) {
			as_string = true
		} else if jsc.JSValueIsObject(ctx, opt) {
			enc := get_named(ctx, cast(jsc.JSObjectRef)opt, "encoding")
			if enc != nil && jsc.JSValueIsString(ctx, enc) do as_string = true
		}
	}
	if as_string {
		defer delete(data, context.allocator)
		return js_string_value(ctx, string(data))
	}

	// Hand ownership of `data` to JavaScriptCore; fs_buffer_deallocator frees it
	// when the typed array is collected.
	array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
		ctx,
		.Uint8Array,
		raw_data(data),
		c.size_t(len(data)),
		fs_buffer_deallocator,
		nil,
		nil,
	)
	return cast(jsc.JSValueRef)array
}

fs_buffer_deallocator :: proc "c" (bytes: rawptr, deallocator_context: rawptr) {
	context = runtime.default_context()
	if bytes != nil do free(bytes)
}

// FS_Read_Request carries an async fs.readFile result from the (synchronous) read
// to the poll-phase callback that invokes the JS callback with (err, data).
FS_Read_Request :: struct {
	ctx:       jsc.JSContextRef,
	callback:  jsc.JSObjectRef, // GC-protected until the completion fires
	data:      []byte, // file contents on success (ownership handed to JSC for Buffer)
	ok:        bool,
	as_string: bool, // an encoding was supplied → deliver a string, else a Uint8Array
	err_msg:   string,
	err_code:  string,
	err_errno: int,
	err_path:  string,
}

// fs.readFile(path[, options], callback). The file is read synchronously and the
// callback is delivered on the event loop's poll phase (queue_io_callback), so it
// runs before any setImmediate scheduled in the same turn — matching Node's
// I/O-callback ordering. (This is not yet threadpool-backed async I/O; the read
// itself is synchronous, but the callback timing matches.)
fs_read_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile requires a path and a callback")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	args := arguments[:int(argument_count)]
	callback := callback_arg(ctx, args[argument_count - 1])
	if callback == nil {
		if exception != nil {
			exception^ = make_js_error(ctx, "fs.readFile callback must be a function")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	// Options sit between path and callback: a string encoding, or { encoding }.
	as_string := false
	if argument_count >= 3 {
		opt := args[1]
		if jsc.JSValueIsString(ctx, opt) {
			as_string = true
		} else if jsc.JSValueIsObject(ctx, opt) {
			enc := get_named(ctx, cast(jsc.JSObjectRef)opt, "encoding")
			if enc != nil && jsc.JSValueIsString(ctx, enc) do as_string = true
		}
	}

	req := new(FS_Read_Request)
	req.ctx = ctx
	req.callback = callback
	req.as_string = as_string
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	data, read_err2 := os.read_entire_file(path_str, context.allocator)
	if read_err2 != os.ERROR_NONE {
		req.ok = false
		req.err_code, req.err_errno = fs_os_error_to_code(read_err2)
		req.err_path, _ = strings.clone(path_str, context.allocator)
		req.err_msg = fmt.aprintf(
			"%s: %s, open '%s'",
			req.err_code,
			fs_errno_text(req.err_code),
			path_str,
			allocator = context.allocator,
		)
	} else {
		req.ok = true
		req.data = data
	}

	loop := get_loop_from_ctx(ctx)
	if loop != nil {
		eventloop.queue_io_callback(loop, fs_read_complete_cb, req)
	} else {
		// No loop bound (e.g. bare eval): deliver inline so the callback still runs.
		fs_read_complete_cb(nil, req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs_read_complete_cb runs in the poll phase and invokes the JS callback with the
// Node (err, data) convention, then releases the request.
fs_read_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Read_Request)user_data
	if req == nil do return
	ctx := req.ctx

	call_args: [2]jsc.JSValueRef
	if req.ok {
		call_args[0] = jsc.JSValueMakeNull(ctx)
		if req.as_string {
			call_args[1] = js_string_value(ctx, string(req.data))
			delete(req.data, context.allocator)
		} else {
			// Hand the bytes to JSC; fs_buffer_deallocator frees them on collection.
			array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
				ctx,
				.Uint8Array,
				raw_data(req.data),
				c.size_t(len(req.data)),
				fs_buffer_deallocator,
				nil,
				nil,
			)
			call_args[1] = cast(jsc.JSValueRef)array
		}
	} else {
		err := make_js_error(ctx, req.err_msg)
		if jsc.JSValueIsObject(ctx, err) {
			err_obj := cast(jsc.JSObjectRef)err
			set_named(ctx, err_obj, "code", js_string_value(ctx, req.err_code))
			set_named(ctx, err_obj, "path", js_string_value(ctx, req.err_path))
			set_named(ctx, err_obj, "syscall", js_string_value(ctx, "open"))
			if req.err_errno != 0 {
				set_named(ctx, err_obj, "errno", jsc.JSValueMakeNumber(ctx, f64(-req.err_errno)))
			}
		}
		call_args[0] = err
		call_args[1] = jsc.JSValueMakeUndefined(ctx)
		if len(req.err_msg) > 0 do delete(req.err_msg, context.allocator)
		if len(req.err_path) > 0 do delete(req.err_path, context.allocator)
	}

	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(call_args[:]), 2, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)req.callback)
	free(req)
}

// --- node:fs: writes, directories, stat ---

// fs_make_error builds a Node-style fs error: an Error with code/syscall/path.
fs_make_error :: proc(ctx: jsc.JSContextRef, code, syscall, path: string, errno_val := 0) -> jsc.JSValueRef {
	msg := fmt.tprintf("%s: %s, %s '%s'", code, fs_errno_text(code), syscall, path)
	err := make_js_error(ctx, msg)
	if jsc.JSValueIsObject(ctx, err) {
		obj := cast(jsc.JSObjectRef)err
		set_named(ctx, obj, "code", js_string_value(ctx, code))
		set_named(ctx, obj, "syscall", js_string_value(ctx, syscall))
		set_named(ctx, obj, "path", js_string_value(ctx, path))
		if errno_val != 0 {
			set_named(ctx, obj, "errno", jsc.JSValueMakeNumber(ctx, f64(-errno_val)))
		}
	}
	return err
}

fs_errno_text :: proc(code: string) -> string {
	switch code {
	case "ENOENT":        return "no such file or directory"
	case "EEXIST":        return "file already exists"
	case "ENOTDIR":       return "not a directory"
	case "EISDIR":        return "illegal operation on a directory"
	case "EACCES":        return "permission denied"
	case "EPERM":         return "operation not permitted"
	case "ENOTEMPTY":     return "directory not empty"
	case "EIO":           return "i/o error"
	case "EROFS":         return "read-only file system"
	case "ENOSPC":        return "no space left on device"
	case "ERR_FS_EISDIR": return "Path is a directory"
	}
	return "i/o error"
}

// Map an os.Error to a Node-compatible error code string and positive errno number.
fs_os_error_to_code :: proc(err: os.Error) -> (code: string, errno_val: int) {
	#partial switch e in err {
	case os.General_Error:
		#partial switch e {
		case .Not_Exist:   return "ENOENT", 2
		case .Exist:       return "EEXIST", 17
		case .Invalid_Dir: return "EISDIR", 21
		case:              return "EIO", 5
		}
	case io.Error:
		#partial switch e {
		case .Permission_Denied: return "EACCES", 13
		case:                    return "EIO", 5
		}
	case os.Platform_Error:
		switch i32(e) {
		case 1:  return "EPERM", 1
		case 2:  return "ENOENT", 2
		case 5:  return "EIO", 5
		case 13: return "EACCES", 13
		case 17: return "EEXIST", 17
		case 20: return "ENOTDIR", 20
		case 21: return "EISDIR", 21
		case 28: return "ENOSPC", 28
		case 30: return "EROFS", 30
		case 39: return "ENOTEMPTY", 39
		case:    return "EIO", 5
		}
	case:
		return "EIO", 5
	}
}

// fs_write_value writes a string or typed-array JS value to disk.
// Returns (true, nil) on success or (false, err) with the actual OS error on failure.
fs_write_value :: proc(ctx: jsc.JSContextRef, path: string, value: jsc.JSValueRef) -> (ok: bool, err: os.Error) {
	if jsc.JSValueGetTypedArrayType(ctx, value, nil) != .None {
		bytes, typed_ok := typed_array_view(ctx, value)
		if !typed_ok || len(bytes) == 0 {
			err = os.write_entire_file_from_bytes(path, nil)
		} else {
			err = os.write_entire_file_from_bytes(path, bytes)
		}
	} else {
		str, alloc := jsc_value_to_string_or_default(ctx, value)
		defer if alloc do delete(str, context.allocator)
		err = os.write_entire_file_from_string(path, str)
	}
	return err == nil, err
}

fs_write_file_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFileSync requires a path and data")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	if write_ok, write_err := fs_write_value(ctx, path_str, args[1]); !write_ok {
		if exception != nil {
			code, errno_val := fs_os_error_to_code(write_err)
			exception^ = fs_make_error(ctx, code, "open", path_str, errno_val)
		}
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// fs.writeFile(path, data[, options], callback) — writes synchronously, then
// delivers callback(err) on the poll phase (same infra as readFile).
fs_write_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFile requires a path, data and a callback")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	callback := callback_arg(ctx, args[argument_count - 1])
	if callback == nil {
		if exception != nil do exception^ = make_js_error(ctx, "fs.writeFile callback must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	req := new(FS_Op_Request)
	req.ctx = ctx
	req.callback = callback
	req.syscall = "open"
	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	if write_ok, write_err := fs_write_value(ctx, path_str, args[1]); write_ok {
		req.ok = true
	} else {
		req.ok = false
		req.err_code, req.err_errno = fs_os_error_to_code(write_err)
		req.err_path, _ = strings.clone(path_str, context.allocator)
	}

	loop := get_loop_from_ctx(ctx)
	if loop != nil {
		eventloop.queue_io_callback(loop, fs_op_complete_cb, req)
	} else {
		fs_op_complete_cb(nil, req)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

// FS_Op_Request backs async fs operations whose callback takes only (err).
FS_Op_Request :: struct {
	ctx:       jsc.JSContextRef,
	callback:  jsc.JSObjectRef,
	ok:        bool,
	err_code:  string,
	err_errno: int,
	err_path:  string,
	syscall:   string,
}

fs_op_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	context = runtime.default_context()
	req := cast(^FS_Op_Request)user_data
	if req == nil do return
	ctx := req.ctx

	call_args: [1]jsc.JSValueRef
	if req.ok {
		call_args[0] = jsc.JSValueMakeNull(ctx)
	} else {
		call_args[0] = fs_make_error(ctx, req.err_code, req.syscall, req.err_path, req.err_errno)
		if len(req.err_path) > 0 do delete(req.err_path, context.allocator)
	}

	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(call_args[:]), 1, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}

	jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)req.callback)
	free(req)
}

// fs_options_recursive reads `options.recursive === true` from an options arg.
fs_options_recursive :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> bool {
	if value == nil || !jsc.JSValueIsObject(ctx, value) do return false
	r := get_named(ctx, cast(jsc.JSObjectRef)value, "recursive")
	if r == nil do return false
	return bool(jsc.JSValueToBoolean(ctx, r))
}

fs_mkdir_recursive :: proc(path: string) -> bool {
	if len(path) == 0 do return false
	if os.exists(path) do return os.is_dir(path)
	parent := filepath.dir(path)
	if parent != path && len(parent) > 0 && !os.exists(parent) {
		if !fs_mkdir_recursive(parent) do return false
	}
	if os.make_directory(path) == nil do return true
	return os.is_dir(path)
}

fs_mkdir_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.mkdirSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	recursive := argument_count >= 2 && fs_options_recursive(ctx, args[1])

	if os.exists(path_str) {
		// Node: recursive mkdir on an existing dir is a no-op; non-recursive or
		// recursive on an existing *file* throws EEXIST.
		if !recursive || !os.is_dir(path_str) {
			if exception != nil do exception^ = fs_make_error(ctx, "EEXIST", "mkdir", path_str, 17)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	ok := recursive ? fs_mkdir_recursive(path_str) : (os.make_directory(path_str) == nil)
	if !ok && exception != nil {
		exception^ = fs_make_error(ctx, "ENOENT", "mkdir", path_str)
	}
	return jsc.JSValueMakeUndefined(ctx)
}

fs_remove_recursive :: proc(path: string) -> bool {
	// Classify without following links (lstat): a symlink — even one pointing at
	// a directory — must be unlinked, never descended into. os.is_dir follows
	// links, so the recursion used to walk INTO the link target and delete its
	// contents outside the removed tree (issue #88). Node removes only the link.
	is_real_dir := false
	if info, stat_err := os.lstat(path, context.allocator); stat_err == nil {
		is_real_dir = info.type == .Directory
		os.file_info_delete(info, context.allocator)
	}
	if is_real_dir {
		handle, open_err := os.open(path)
		if open_err == nil {
			infos, read_err := os.read_directory(handle, -1, context.allocator)
			os.close(handle)
			if read_err == nil {
				for info in infos {
					child, join_err := filepath.join({path, info.name}, context.allocator)
					if join_err == nil {
						fs_remove_recursive(child)
						delete(child, context.allocator)
					}
				}
				os.file_info_slice_delete(infos, context.allocator)
			}
		}
	}
	return os.remove(path) == nil
}

fs_rm_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.rmSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	force := false
	recursive := false
	if argument_count >= 2 && jsc.JSValueIsObject(ctx, args[1]) {
		opts := cast(jsc.JSObjectRef)args[1]
		recursive = fs_options_recursive(ctx, args[1])
		f := get_named(ctx, opts, "force")
		if f != nil do force = bool(jsc.JSValueToBoolean(ctx, f))
	}

	// Use lstat so a dangling symlink is visible (os.exists follows links and
	// would incorrectly treat a dangling symlink as "not found").
	lstat_info, lstat_err := os.lstat(path_str, context.allocator)
	path_missing := lstat_err != nil
	is_dir := !path_missing && lstat_info.type == .Directory
	if lstat_err == nil do os.file_info_delete(lstat_info, context.allocator)

	if path_missing {
		if !force && exception != nil {
			exception^ = fs_make_error(ctx, "ENOENT", "stat", path_str, 2)
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	if recursive {
		ok := fs_remove_recursive(path_str)
		if !ok && !force && exception != nil {
			exception^ = fs_make_error(ctx, "ENOTEMPTY", "rmdir", path_str, 39)
		}
	} else {
		// Non-recursive on a directory: Node 22 throws ERR_FS_EISDIR regardless of
		// whether the dir is empty, because rm(1) requires --recursive/-r for dirs.
		if is_dir && !force {
			if exception != nil do exception^ = fs_make_error(ctx, "ERR_FS_EISDIR", "rm", path_str, 21)
			return jsc.JSValueMakeUndefined(ctx)
		}
		remove_err := os.remove(path_str)
		if remove_err != nil && !force && exception != nil {
			code, errno_val := fs_os_error_to_code(remove_err)
			exception^ = fs_make_error(ctx, code, "rm", path_str, errno_val)
		}
	}
	return jsc.JSValueMakeUndefined(ctx)
}

fs_time_ms :: proc(t: time.Time) -> f64 {
	return f64(time.to_unix_nanoseconds(t)) / 1.0e6
}

stats_ftype :: proc(ctx: jsc.JSContextRef, obj: jsc.JSObjectRef) -> int {
	v := get_named(ctx, obj, "__lava_ftype")
	if v == nil do return 0
	return int(jsc.JSValueToNumber(ctx, v, nil))
}

stats_is_file_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 1))
}

stats_is_directory_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 2))
}

stats_is_symlink_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	return jsc.JSValueMakeBoolean(ctx, b32(stats_ftype(ctx, this_object) == 3))
}

fs_build_stats :: proc(ctx: jsc.JSContextRef, info: os.File_Info) -> jsc.JSValueRef {
	obj := jsc.JSObjectMake(ctx, nil, nil)

	set_named(ctx, obj, "size", jsc.JSValueMakeNumber(ctx, f64(info.size)))
	set_named(ctx, obj, "mtimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.modification_time)))
	set_named(ctx, obj, "atimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.access_time)))
	set_named(ctx, obj, "ctimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.modification_time)))
	set_named(ctx, obj, "birthtimeMs", jsc.JSValueMakeNumber(ctx, fs_time_ms(info.creation_time)))

	ftype := 0
	#partial switch info.type {
	case .Regular:
		ftype = 1
	case .Directory:
		ftype = 2
	case .Symlink:
		ftype = 3
	}
	// __lava_ftype backs the is*() methods; kept non-enumerable so it does not
	// surface in Object.keys / JSON.stringify of the Stats object.
	ftype_name := jsc.JSStringCreateWithUTF8CString("__lava_ftype")
	defer jsc.JSStringRelease(ftype_name)
	jsc.JSObjectSetProperty(
		ctx,
		obj,
		ftype_name,
		jsc.JSValueMakeNumber(ctx, f64(ftype)),
		{.DontEnum},
		nil,
	)

	inject_native_function(ctx, obj, "isFile", stats_is_file_cb)
	inject_native_function(ctx, obj, "isDirectory", stats_is_directory_cb)
	inject_native_function(ctx, obj, "isSymbolicLink", stats_is_symlink_cb)
	return cast(jsc.JSValueRef)obj
}

fs_stat_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.statSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	info, stat_err := os.stat(path_str, context.allocator)
	if stat_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOENT", "stat", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer os.file_info_delete(info, context.allocator)

	return fs_build_stats(ctx, info)
}

fs_readdir_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 {
		if exception != nil do exception^ = make_js_error(ctx, "fs.readdirSync requires a path")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]
	path_str, path_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if path_alloc do delete(path_str, context.allocator)

	handle, open_err := os.open(path_str)
	if open_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOENT", "scandir", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	infos, read_err := os.read_directory(handle, -1, context.allocator)
	os.close(handle)
	if read_err != nil {
		if exception != nil do exception^ = fs_make_error(ctx, "ENOTDIR", "scandir", path_str)
		return jsc.JSValueMakeUndefined(ctx)
	}
	defer os.file_info_slice_delete(infos, context.allocator)

	if len(infos) == 0 {
		return cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, 0, nil, nil)
	}
	values := make([]jsc.JSValueRef, len(infos), context.temp_allocator)
	for info, i in infos {
		values[i] = js_string_value(ctx, info.name)
	}
	arr := jsc.JSObjectMakeArray(ctx, c.size_t(len(values)), raw_data(values), nil)
	return cast(jsc.JSValueRef)arr
}

fs_exists_sync_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeBoolean(ctx, false)

	args := arguments[:int(argument_count)]
	path_str, alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if alloc do delete(path_str, context.allocator)

	return jsc.JSValueMakeBoolean(ctx, b32(module_file_exists(path_str)))
}
