package jsc

import "core:c"

foreign import jsc_lib "system:javascriptcoregtk-6.0"

JSContextRef :: rawptr
JSGlobalContextRef :: JSContextRef

JSStringRef :: distinct rawptr
JSValueRef :: distinct rawptr
JSObjectRef :: distinct rawptr
JSClassRef :: distinct rawptr

JSChar :: u16

JSType :: enum c.int {
	Undefined,
	Null,
	Boolean,
	Number,
	String,
	Object,
	Symbol,
}

JSClassAttributes :: enum c.uint {
	None                 = 0,
	NoAutomaticPrototype = 1 << 0,
}

JSPropertyAttribute :: enum c.uint {
	ReadOnly   = 1, // 1 << 1 в C API
	DontEnum   = 2, // 1 << 2 в C API
	DontDelete = 3, // 1 << 3 в C API
}
JSPropertyAttributes :: bit_set[JSPropertyAttribute;c.uint]

JSClassDefinition :: struct {
	version:             c.int,
	attributes:          JSClassAttributes,
	class_name:          cstring,
	parent_class:        JSClassRef,
	static_values:       ^JSStaticValue,
	static_functions:    ^JSStaticFunction,
	initialize:          proc "c" (ctx: JSContextRef, object: JSObjectRef),
	finalize:            proc "c" (object: JSObjectRef),
	has_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
	) -> b32,
	get_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> JSValueRef,
	set_property:        proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		value: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	delete_property:     proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> b32,
	get_property_names:  proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_names: rawptr,
	), // JSPropertyNameAccumulatorRef
	call_as_function:    JSObjectCallAsFunctionCallback,
	call_as_constructor: JSObjectCallAsConstructorCallback,
	has_instance:        proc "c" (
		ctx: JSContextRef,
		constructor: JSObjectRef,
		possible_instance: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	convert_to_type:     proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		type: JSType,
		exception: ^JSValueRef,
	) -> JSValueRef,
}

JSStaticValue :: struct {
	name:         cstring,
	get_property: proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		exception: ^JSValueRef,
	) -> JSValueRef,
	set_property: proc "c" (
		ctx: JSContextRef,
		object: JSObjectRef,
		property_name: JSStringRef,
		value: JSValueRef,
		exception: ^JSValueRef,
	) -> b32,
	attributes:   JSPropertyAttributes,
}

JSStaticFunction :: struct {
	name:             cstring,
	call_as_function: JSObjectCallAsFunctionCallback,
	attributes:       JSPropertyAttributes,
}

// --- Канонічні сигнатури Колбеків (Callbacks) ---
JSObjectCallAsFunctionCallback :: proc "c" (
	ctx: JSContextRef,
	function: JSObjectRef,
	this_object: JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]JSValueRef,
	exception: ^JSValueRef,
) -> JSValueRef

JSObjectCallAsConstructorCallback :: proc "c" (
	ctx: JSContextRef,
	constructor: JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]JSValueRef,
	exception: ^JSValueRef,
) -> JSObjectRef


@(default_calling_convention = "c")
foreign jsc_lib {
	JSGlobalContextCreate :: proc(global_object_class: JSClassRef) -> JSGlobalContextRef ---
	JSGlobalContextRelease :: proc(ctx: JSGlobalContextRef) ---

	JSStringCreateWithUTF8CString :: proc(string: cstring) -> JSStringRef ---
	JSStringGetMaximumUTF8CStringSize :: proc(string: JSStringRef) -> c.size_t ---
	JSStringGetUTF8CString :: proc(string: JSStringRef, buffer: [^]byte, buffer_size: c.size_t) -> c.size_t ---
	JSStringRelease :: proc(string: JSStringRef) ---
	JSStringIsEqualToUTF8CString :: proc(a: JSStringRef, b: cstring) -> b32 ---

	JSValueMakeUndefined :: proc(ctx: JSContextRef) -> JSValueRef ---
	JSValueMakeNull :: proc(ctx: JSContextRef) -> JSValueRef ---
	JSValueMakeBoolean :: proc(ctx: JSContextRef, boolean: b32) -> JSValueRef ---
	JSValueMakeNumber :: proc(ctx: JSContextRef, number: f64) -> JSValueRef ---
	JSValueMakeString :: proc(ctx: JSContextRef, string: JSStringRef) -> JSValueRef ---

	JSValueGetType :: proc(ctx: JSContextRef, value: JSValueRef) -> JSType ---
	JSValueIsUndefined :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsNull :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsBoolean :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsNumber :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsString :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsObject :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsArray :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueIsStrictEqual :: proc(ctx: JSContextRef, a: JSValueRef, b: JSValueRef) -> b32 ---

	JSValueToBoolean :: proc(ctx: JSContextRef, value: JSValueRef) -> b32 ---
	JSValueToNumber :: proc(ctx: JSContextRef, value: JSValueRef, exception: ^JSValueRef) -> f64 ---
	JSValueToStringCopy :: proc(ctx: JSContextRef, value: JSValueRef, exception: ^JSValueRef) -> JSStringRef ---

	JSContextGetGlobalObject :: proc(ctx: JSContextRef) -> JSObjectRef ---

	JSObjectMake :: proc(ctx: JSContextRef, js_class: JSClassRef, data: rawptr) -> JSObjectRef ---
	JSObjectMakeFunctionWithCallback :: proc(ctx: JSContextRef, name: JSStringRef, call_as_function: JSObjectCallAsFunctionCallback) -> JSObjectRef ---

	JSObjectGetProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectSetProperty :: proc(ctx: JSContextRef, object: JSObjectRef, property_name: JSStringRef, value: JSValueRef, attributes: JSPropertyAttributes, exception: ^JSValueRef) ---
	JSObjectGetPropertyAtIndex :: proc(ctx: JSContextRef, object: JSObjectRef, property_index: c.uint, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectSetPropertyAtIndex :: proc(ctx: JSContextRef, object: JSObjectRef, property_index: c.uint, value: JSValueRef, exception: ^JSValueRef) ---

	JSObjectCallAsFunction :: proc(ctx: JSContextRef, object: JSObjectRef, this_object: JSObjectRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSValueRef ---
	JSObjectCallAsConstructor :: proc(ctx: JSContextRef, object: JSObjectRef, argument_count: c.size_t, arguments: [^]JSValueRef, exception: ^JSValueRef) -> JSObjectRef ---

	JSEvaluateScript :: proc(ctx: JSContextRef, script: JSStringRef, this_object: JSObjectRef, source_url: JSStringRef, starting_line_number: c.int, exception: ^JSValueRef) -> JSValueRef ---
}
