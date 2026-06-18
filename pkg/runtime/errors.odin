package lava_runtime

import "core:fmt"
import jsc "lava:pkg/jsc"

// Centralized Node-error construction. One place owns the (name, message, code)
// shape every native-thrown error carries, so Lava's errors match both Node's and
// the JS standard-library layer's (which sets `err.code = 'ERR_*'` per module)
// instead of being assembled ad hoc — a base Error plus a manual `name`/`code`
// patch — at each call site. See docs/ARCHITECTURE.md §5.1.

// make_native_error builds a *real* instance of a JS error constructor
// (Error / TypeError / RangeError / SyntaxError / …) looked up on globalThis, so
// `err instanceof TypeError` holds exactly as in Node — not merely `err.name ===
// "TypeError"`. `code`, when non-empty, is attached as Node's `err.code` string
// (e.g. "ERR_OUT_OF_RANGE").
//
// If the constructor cannot be resolved or invoked (a torn-down or only partially
// initialized context, where globalThis has no such binding), it falls back to a
// base Error with `name` overridden — the pre-factory behavior — so the message
// and code still surface. The JSValueIs* / JSObjectIsConstructor predicates used
// here are ABI-safe (see cmd/lava jsc_value_predicates, #159).
make_native_error :: proc(
	ctx: jsc.JSContextRef,
	ctor_name: string,
	message: string,
	code: string = "",
) -> jsc.JSValueRef {
	msg := js_string_value(ctx, message)
	args := [1]jsc.JSValueRef{msg}

	err: jsc.JSValueRef
	global := jsc.JSContextGetGlobalObject(ctx)
	ctor := get_named(ctx, global, ctor_name)
	if ctor != nil &&
	   jsc.JSValueIsObject(ctx, ctor) &&
	   jsc.JSObjectIsConstructor(ctx, cast(jsc.JSObjectRef)ctor) {
		built := jsc.JSObjectCallAsConstructor(ctx, cast(jsc.JSObjectRef)ctor, 1, raw_data(args[:]), nil)
		if built != nil do err = cast(jsc.JSValueRef)built
	}

	if err == nil {
		// Fallback: base Error with an overridden name (matches the old
		// make_js_named_error behavior when a real constructor is unreachable).
		base := jsc.JSObjectMakeError(ctx, 1, raw_data(args[:]), nil)
		err = cast(jsc.JSValueRef)base
		if ctor_name != "Error" && jsc.JSValueIsObject(ctx, err) {
			set_named(ctx, cast(jsc.JSObjectRef)err, "name", js_string_value(ctx, ctor_name))
		}
	}

	if len(code) > 0 && jsc.JSValueIsObject(ctx, err) {
		set_named(ctx, cast(jsc.JSObjectRef)err, "code", js_string_value(ctx, code))
	}
	return err
}

// make_js_error builds a plain Error carrying `message` and no `code` — the
// common case for operational failures that do not map to a Node `ERR_*` code.
make_js_error :: proc(ctx: jsc.JSContextRef, message: string) -> jsc.JSValueRef {
	return make_native_error(ctx, "Error", message)
}

// make_js_named_error builds a real instance of the named error subclass
// (e.g. "RangeError", "SyntaxError") carrying `message`, no code. New code that
// needs a Node `code` should prefer make_native_error or an err_* helper below.
make_js_named_error :: proc(ctx: jsc.JSContextRef, name, message: string) -> jsc.JSValueRef {
	return make_native_error(ctx, name, message)
}

// --- Node ERR_* taxonomy helpers ---
//
// Each mirrors Node's lib/internal/errors message template and code so native
// errors read identically to Node's (and the JS layer's). Grow this list as
// native call sites adopt coded errors.

// ERR_OUT_OF_RANGE (RangeError): a value outside its valid range. `range`
// describes the expectation (e.g. "an integer", ">= 0 and <= 255"); `received`
// is the offending value rendered for display (e.g. "NaN", "-1").
err_out_of_range :: proc(ctx: jsc.JSContextRef, name, range, received: string) -> jsc.JSValueRef {
	msg := fmt.tprintf(
		"The value of \"%s\" is out of range. It must be %s. Received %s",
		name,
		range,
		received,
	)
	return make_native_error(ctx, "RangeError", msg, "ERR_OUT_OF_RANGE")
}

// ERR_INVALID_ARG_TYPE (TypeError): an argument of the wrong type. `expected`
// is the accepted-type description (e.g. "Uint8Array", "string or number");
// `received` is the actual type (e.g. "number", "undefined").
err_invalid_arg_type :: proc(ctx: jsc.JSContextRef, name, expected, received: string) -> jsc.JSValueRef {
	msg := fmt.tprintf(
		"The \"%s\" argument must be of type %s. Received %s",
		name,
		expected,
		received,
	)
	return make_native_error(ctx, "TypeError", msg, "ERR_INVALID_ARG_TYPE")
}
