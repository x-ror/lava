// Linux-only: the private-ABI host-call path is compiled only for Linux
// (pkg/jsc/host_function.odin), so off Linux nothing is ever registered in the
// host-native registry and a dispatch miss cannot occur.
#+build linux
package main

import "core:c"
import "core:strings"
import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Pins the fail-CLOSED dispatcher (pkg/runtime/host_natives.odin). The commit
// that introduced it claimed this was untestable without a fault-injection
// harness. That was wrong: host_natives_release_context is exported and produces
// exactly the inconsistent-registry state, while globalThis keeps the function
// object reachable — so the miss needs no production seam, no test-only hook and
// no allocator games.
//
// Why it is worth pinning: several natives write through a caller-supplied
// buffer and signal nothing on return, so a dispatcher answering `undefined` is
// silently WRONG rather than merely unhelpful. crypto.js does
// `var buf = Buffer.alloc(size); native.randomFill(buf); return buf;` — alloc
// zeroes and the result is discarded, so randomBytes(8) would hand back eight
// zero bytes that the caller treats as CSPRNG output. randomFillSync,
// getRandomValues and randomUUID share the shape.
//
// Three assertions, each pinning a distinct failure this has already had:
//   1. a registered native dispatches (otherwise the rest proves nothing);
//   2. after the sweep the call THROWS, and with our message — reverting the
//      fail-closed branch gives "NO THROW: undefined", and dropping the sweep's
//      delete_key(&g_host_native_cbs, ...) gives "NO THROW: 42" because the stale
//      callee entry keeps dispatching;
//   3. the VM still works afterwards — this is what pins the private-ABI contract
//      that host_throw actually RAISED. Returning the Error object as an ordinary
//      value (which is what a bare `return exception` does when host_throw
//      no-ops) is fail-open again, not a throw.
@(private = "file")
probe_native_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	return jsc.JSValueMakeNumber(ctx, 42)
}

@(private = "file")
eval_to_string :: proc(ctx: jsc.JSContextRef, source: string) -> (string, bool) {
	c_src, err := strings.clone_to_cstring(source, context.temp_allocator)
	if err != nil do return "", false
	js_src := jsc.JSStringCreateWithUTF8CString(c_src)
	defer jsc.JSStringRelease(js_src)

	exception: jsc.JSValueRef
	value := jsc.JSEvaluateScript(ctx, js_src, nil, nil, 1, &exception)
	if exception != nil || value == nil do return "", false
	// Owned context.allocator buffer; freed here and re-cloned into the temp arena so
	// the runner's per-test tracking allocator does not report the helper as a leak.
	owned, got := lava.jsc_value_to_string_or_default(ctx, value)
	if !got do return "", true // empty string: nothing was allocated
	defer delete(owned)
	copied, clone_err := strings.clone(owned, context.temp_allocator)
	if clone_err != nil do return "", false
	return copied, true
}

@(test)
host_native_dispatch_miss_fails_closed :: proc(t: ^testing.T) {
	gclass := lava.make_global_class()
	gctx := jsc.JSGlobalContextCreate(gclass)
	testing.expect(t, gctx != nil, "could not create a JSC global context")
	if gctx == nil {
		jsc.JSClassRelease(gclass)
		return
	}
	defer jsc.JSClassRelease(gclass)
	defer jsc.JSGlobalContextRelease(gctx)
	ctx := cast(jsc.JSContextRef)gctx

	// Without the private-ABI path nothing is registered, so there is no miss to
	// observe and every assertion below would pass vacuously.
	if !jsc.host_calls_active(ctx) {
		testing.expect(
			t,
			false,
			"private-ABI host-call path inactive — this test cannot observe the defect it pins",
		)
		return
	}

	state := lava.new_runtime_state(nil)
	jsc.JSObjectSetPrivate(jsc.JSContextGetGlobalObject(ctx), cast(rawptr)state)
	lava.capture_error_intrinsics(ctx, state)
	defer lava.destroy_runtime_state(ctx, state)

	lava.inject_native_function(ctx, jsc.JSContextGetGlobalObject(ctx), "probe", probe_native_cb)

	before, ok_before := eval_to_string(ctx, "String(probe())")
	testing.expectf(t, ok_before && before == "42", "registered native did not dispatch: %q", before)

	// Drop this context's registrations while the JS function object stays rooted
	// on globalThis — the registry is now inconsistent and the next call misses.
	lava.host_natives_release_context(ctx, state.allocator)

	after, ok_after := eval_to_string(
		ctx,
		"(function(){ try { return 'NO THROW: ' + probe(); } catch (e) { return 'threw: ' + e.message; } })()",
	)
	testing.expectf(
		t,
		ok_after && strings.has_prefix(after, "threw: lava: host native dispatch failed"),
		"dispatch miss did not fail closed: %q",
		after,
	)

	// The raise must leave the VM usable: a pending-but-uncleared exception, or an
	// empty JSValue returned in place of one, would break the next evaluation.
	healthy, ok_healthy := eval_to_string(ctx, "String(1 + 1)")
	testing.expectf(t, ok_healthy && healthy == "2", "VM unusable after the raise: %q", healthy)
}
