package lava_runtime

import "base:runtime"
import "core:c"
import "core:strings"
import jsc "lava:pkg/jsc"

// Generic host-call registration for every injected native. Explicit per-proc
// wrappers (buffer_host.odin) bake their callback into a dedicated entry
// point; everything else goes through one shared trampoline that recovers the
// callback from the frame's callee slot — the JSFunction cell being invoked —
// via a pointer-keyed table. Created functions are protected (their address IS
// the dispatch key, so the cell must never be collected and reused) and cached
// per (context, callback, name), so per-instance injections like the fs.Stats
// methods reuse one function object instead of minting a new one per call —
// like methods living on a prototype.

// host_dispatch adapts JSC's internal calling convention to a C-API-shaped
// callback: argument slots ARE JSValueRefs on 64-bit, the callee/this cells
// pass as the function/thisObject parameters (nil when `this` is not a cell —
// the callbacks that read it only ever receive objects), and a callback-set
// exception becomes a real VM throw, matching JSCallbackFunction.
host_dispatch :: proc "c" (
	global: rawptr,
	cf: [^]u64,
	cb: jsc.JSObjectCallAsFunctionCallback,
) -> i64 {
	ctx := jsc.JSContextRef(global)
	argc := int(u32(cf[jsc.CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)) - 1 // minus `this`
	if argc < 0 do argc = 0
	if argc > 16 do argc = 16 // widest native today reads arguments[9] (fetch)
	args: [16]jsc.JSValueRef
	for i in 0 ..< argc {
		args[i] = jsc.JSValueRef(uintptr(cf[jsc.CALL_FRAME_FIRST_ARG_SLOT + i]))
	}
	callee := host_cell_object(cf[jsc.CALL_FRAME_CALLEE_SLOT])
	this := host_cell_object(cf[jsc.CALL_FRAME_THIS_SLOT])
	exception: jsc.JSValueRef
	ret := cb(ctx, callee, this, c.size_t(argc), &args[0], &exception)
	if exception != nil {
		jsc.host_throw(ctx, exception)
		return transmute(i64)exception
	}
	if ret == nil do return transmute(i64)jsc.JSValueMakeUndefined(ctx)
	return transmute(i64)ret
}

@(private = "file")
host_cell_object :: proc "contextless" (bits: u64) -> jsc.JSObjectRef {
	if bits == 0 || (bits & jsc.VALUE_NOT_CELL_MASK) != 0 do return nil
	return jsc.JSObjectRef(uintptr(bits))
}

@(private = "file")
Host_Native_Key :: struct {
	ctx:  rawptr,
	cb:   rawptr,
	name: string,
}

@(private = "file") g_host_native_fns: map[Host_Native_Key]jsc.JSObjectRef
@(private = "file") g_host_native_cbs: map[rawptr]jsc.JSObjectCallAsFunctionCallback

@(private = "file")
generic_native_host_cb :: proc "c" (global: rawptr, cf: [^]u64) -> i64 {
	context = runtime.default_context()
	cb, found := g_host_native_cbs[rawptr(uintptr(cf[jsc.CALL_FRAME_CALLEE_SLOT]))]
	if !found do return transmute(i64)jsc.JSValueMakeUndefined(jsc.JSContextRef(global))
	return host_dispatch(global, cf, cb)
}

// host_native_create returns a host-registered function for `cb` (creating and
// caching it on first use), or nil when the host-call path is unavailable —
// the caller falls back to JSObjectMakeFunctionWithCallback.
host_native_create :: proc(
	ctx: jsc.JSContextRef,
	name: string,
	cb: jsc.JSObjectCallAsFunctionCallback,
) -> jsc.JSObjectRef {
	key := Host_Native_Key{rawptr(ctx), transmute(rawptr)cb, name}
	if fn, hit := g_host_native_fns[key]; hit do return fn

	fn, ok := jsc.host_function_create(ctx, name, generic_native_host_cb, 1)
	if !ok || fn == nil do return nil
	jsc.JSValueProtect(ctx, jsc.JSValueRef(fn))
	key.name = strings.clone(name) // outlive the caller's (possibly temp) string
	g_host_native_fns[key] = fn
	g_host_native_cbs[rawptr(fn)] = cb
	return fn
}
