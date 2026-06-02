package jsc

// Initial JavaScriptCore C API surface. This package is intentionally small
// while the runtime shape is still forming.

foreign import jsc_lib "system:javascriptcoregtk-4.1"

JSGlobalContextRef :: distinct rawptr
JSContextRef :: distinct rawptr
JSStringRef :: distinct rawptr
JSValueRef :: distinct rawptr
JSObjectRef :: distinct rawptr
JSClassRef :: distinct rawptr

JSChar :: u16

foreign jsc_lib {
	JSGlobalContextCreate :: proc(global_object_class: JSClassRef) -> JSGlobalContextRef ---
	JSGlobalContextRelease :: proc(ctx: JSGlobalContextRef) ---

	JSStringCreateWithUTF8CString :: proc(string: cstring) -> JSStringRef ---
	JSStringRelease :: proc(string: JSStringRef) ---

	JSEvaluateScript :: proc(
		ctx: JSContextRef,
		script: JSStringRef,
		this_object: JSObjectRef,
		source_url: JSStringRef,
		starting_line_number: i32,
		exception: ^JSValueRef,
	) -> JSValueRef ---
}

