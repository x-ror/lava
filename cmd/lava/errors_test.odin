#+build linux, darwin
package main

import "core:fmt"
import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Verifies the centralized Node-error factory (errors.odin, docs/ARCHITECTURE.md
// §5.1): a coded error must be a *real* instance of its JS constructor (so
// `instanceof` matches Node, not just `err.name`), expose `err.code`, and a plain
// Error must carry no code. Also pins the Node message templates of the err_*
// helpers. Scoped linux+darwin, where `odin test cmd/lava` reliably links/loads JSC.
@(test)
node_error_factory :: proc(t: ^testing.T) {
	jsc.lava_jsc_init()
	gctx := jsc.JSGlobalContextCreate(nil)
	testing.expect(t, gctx != nil, "could not create a JSC global context")
	if gctx == nil do return
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	// A coded RangeError is a real RangeError instance (not a base Error with an
	// overridden name), carries the message, and exposes err.code.
	re := lava.make_native_error(ctx, "RangeError", "too big", "ERR_OUT_OF_RANGE")
	expect_error_shape(t, ctx, re, "RangeError", "RangeError", "too big", "ERR_OUT_OF_RANGE")

	// A plain Error has no code (err.code === undefined).
	e := lava.make_js_error(ctx, "boom")
	expect_error_shape(t, ctx, e, "Error", "Error", "boom", "")

	// err_out_of_range reproduces Node's message template exactly.
	oor := lava.err_out_of_range(ctx, "code", "an integer", "NaN")
	expect_error_shape(
		t,
		ctx,
		oor,
		"RangeError",
		"RangeError",
		"The value of \"code\" is out of range. It must be an integer. Received NaN",
		"ERR_OUT_OF_RANGE",
	)

	// err_invalid_arg_type is a real TypeError with the Node template + code.
	te := lava.err_invalid_arg_type(ctx, "buf", "Uint8Array", "number")
	expect_error_shape(
		t,
		ctx,
		te,
		"TypeError",
		"TypeError",
		"The \"buf\" argument must be of type Uint8Array. Received number",
		"ERR_INVALID_ARG_TYPE",
	)
}

// expect_error_shape asserts that `err` is a real instance of `instanceof_ctor`
// (checked through real JS, with the error exposed as the global `__e`) and has
// the expected name, message, and code. An empty want_code asserts err.code is
// undefined.
@(private = "file")
expect_error_shape :: proc(
	t: ^testing.T,
	ctx: jsc.JSContextRef,
	err: jsc.JSValueRef,
	instanceof_ctor: string,
	want_name, want_message, want_code: string,
) {
	testing.expect(t, jsc.JSValueIsObject(ctx, err), "error value must be an object")
	if !jsc.JSValueIsObject(ctx, err) do return
	obj := cast(jsc.JSObjectRef)err

	global := jsc.JSContextGetGlobalObject(ctx)
	lava.set_named(ctx, global, "__e", err)
	expr := fmt.tprintf("__e instanceof %s", instanceof_ctor)
	testing.expectf(t, eval_truthy(ctx, expr), "expected instanceof %s", instanceof_ctor)

	check_string_prop(t, ctx, obj, "name", want_name)
	check_string_prop(t, ctx, obj, "message", want_message)

	code_v := lava.get_named(ctx, obj, "code")
	if want_code == "" {
		testing.expect(t, jsc.JSValueIsUndefined(ctx, code_v), "plain error should have no code")
	} else {
		check_string_prop(t, ctx, obj, "code", want_code)
	}
}

@(private = "file")
check_string_prop :: proc(t: ^testing.T, ctx: jsc.JSContextRef, obj: jsc.JSObjectRef, prop, want: string) {
	v := lava.get_named(ctx, obj, prop)
	got, allocated := lava.value_to_string(ctx, v)
	defer if allocated do delete(got)
	testing.expectf(t, got == want, "%s: got %q want %q", prop, got, want)
}

@(private = "file")
eval_truthy :: proc(ctx: jsc.JSContextRef, expr: string) -> bool {
	c_expr, err := strings.clone_to_cstring(expr, context.temp_allocator)
	if err != nil do return false
	src := jsc.JSStringCreateWithUTF8CString(c_expr)
	defer jsc.JSStringRelease(src)
	exc: jsc.JSValueRef
	v := jsc.JSEvaluateScript(ctx, src, nil, nil, 1, &exc)
	if exc != nil || v == nil do return false
	return jsc.JSValueToBoolean(ctx, v)
}
