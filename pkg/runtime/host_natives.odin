package lava_runtime

import "base:runtime"
import "core:c"
import "core:mem"
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
	context = runtime.default_context() // valid allocator for the overflow slice below
	ctx := jsc.JSContextRef(global)
	argc := int(u32(cf[jsc.CALL_FRAME_ARGC_SLOT] & 0xFFFFFFFF)) - 1 // minus `this`
	if argc < 0 do argc = 0
	// Deliver every argument. Fixed stack buffer for the common small case; a
	// genuinely variadic caller (setTimeout(fn, delay, ...args)) that overflows
	// it uses a temp slice rather than being silently truncated.
	stack_args: [16]jsc.JSValueRef
	args: []jsc.JSValueRef = stack_args[:]
	if argc > len(stack_args) {
		args = make([]jsc.JSValueRef, argc, context.temp_allocator)
	}
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

// js_int_arg reads an integer argument without a C-API call when it is an
// immediate int32 (the common case for offsets/lengths from the JS layer).
js_int_arg :: proc(ctx: jsc.JSContextRef, v: jsc.JSValueRef) -> int {
	if x, ok := jsc.value_int32(ctx, v); ok do return int(x)
	return int(jsc.JSValueToNumber(ctx, v, nil))
}

// js_int_value encodes an integer result without a C-API call when possible.
js_int_value :: proc(ctx: jsc.JSContextRef, v: int) -> jsc.JSValueRef {
	if v >= -2147483648 && v <= 2147483647 {
		if r, ok := jsc.make_int32(ctx, i32(v)); ok do return r
	}
	return jsc.JSValueMakeNumber(ctx, f64(v))
}

@(private = "file")
Host_Native_Key :: struct {
	ctx:  rawptr,
	cb:   rawptr,
	name: string,
}

// Thread-local: a JSC context is thread-confined, so a worker's registered
// functions (JSObjectRefs) and the callee->callback dispatch table belong to
// that worker's thread. Per-thread maps mean registration and the per-call
// dispatch lookup never touch another worker's state — no locks on the dispatch
// path, and no data race when N workers build their bindings concurrently
// (the failure the removed process-global interning risked). The dispatch
// callback runs on the ctx-owning thread, so it reads the same thread's table.
//
// Both tables are swept per context by host_natives_release_context, called from
// destroy_runtime_state while the context is still alive. Without that sweep the
// entries outlive the context they were registered for, and JSC hands the SAME
// address to a later JSGlobalContextCreate: the {ctx, cb, name} key then collides
// with a dead context's entry, the cache returns a JSObjectRef into freed memory,
// and the new VM's object at that address is called instead (observed: the
// `allocUninit` binding resolving to Map.prototype.values, plus segfaults and
// tracking-allocator bad frees, from the 3rd-4th eval in one process).
//
// The BACKING of both maps is bound explicitly to a process-lifetime allocator,
// never implicitly to the ambient one. Odin binds a zero-valued map's allocator
// on its first grow (base/runtime/dynamic_map_internal.odin: `if
// m.allocator.procedure == nil { m.allocator = context.allocator }`), and the
// first insert happens inside setup_module_environment under the CALLER's
// context. These tables are thread-lived and never deleted, so an implicit bind
// captures an allocator that dies long before they do: under the Odin test
// runner (a per-test tracking allocator over a rollback stack that is
// free_all'd between tests) or an embedder's per-eval arena, every later insert
// writes through a reclaimed backing and corrupts whatever now occupies it.
// Same rule Runtime_State.module_cache already follows (globals.odin).
@(private = "file", thread_local) g_host_native_fns: map[Host_Native_Key]jsc.JSObjectRef
@(private = "file", thread_local) g_host_native_cbs: map[rawptr]jsc.JSObjectCallAsFunctionCallback
@(private = "file", thread_local) g_host_tables_bound: bool

// bind_host_tables gives both tables a backing allocator that outlives them,
// before anything can insert. runtime.default_allocator() is the only lifetime
// that matches a thread-lived table: state.allocator dies with the eval, and the
// ambient one is whatever the caller happened to install.
@(private = "file")
bind_host_tables :: proc() {
	if g_host_tables_bound do return
	g_host_tables_bound = true
	g_host_native_fns = make(map[Host_Native_Key]jsc.JSObjectRef, 64, runtime.default_allocator())
	g_host_native_cbs = make(
		map[rawptr]jsc.JSObjectCallAsFunctionCallback,
		64,
		runtime.default_allocator(),
	)
}

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
	// Lookup first: the hit path is hot (measured ~60k hits per 20k fs.statSync,
	// three per Stats instance) and must not pay for anything below it.
	if fn, hit := g_host_native_fns[key]; hit do return fn

	fn, ok := jsc.host_function_create(ctx, name, generic_native_host_cb, 1)
	if !ok || fn == nil do return nil
	jsc.JSValueProtect(ctx, jsc.JSValueRef(fn))
	bind_host_tables()
	// Clone through the Runtime_State's allocator, not the ambient one: this runs
	// from inject_native_function, which is reachable both from ordinary eval-time
	// setup AND from inside native_require_cb (a proc "c" whose context is reset to
	// runtime.default_context()). The sweep frees through the same state allocator,
	// so the two must not be picked up from whatever context happened to be live.
	alloc := context.allocator
	if state := get_state_from_ctx(ctx); state != nil do alloc = state.allocator
	cloned, clone_err := strings.clone(name, alloc)
	if clone_err != nil {
		// Raw unprotect on purpose, unlike the sweep below: a mid-run rollback of
		// the protect taken above, with the context fully healthy.
		// unprotect_before_eval_exit's Windows carve-out is about FINAL teardown
		// racing the VM's GC/JIT workers; using it here would leak a root instead.
		jsc.JSValueUnprotect(ctx, jsc.JSValueRef(fn))
		return nil
	}
	key.name = cloned // outlive the caller's (possibly temp) string
	g_host_native_fns[key] = fn
	g_host_native_cbs[rawptr(fn)] = cb
	return fn
}

// host_natives_release_context drops every registration made for `ctx`. MUST run
// while `ctx` is still alive (JSValueUnprotect needs it) and before any later
// JSGlobalContextCreate can reuse the address — destroy_runtime_state is that
// point. `alloc` is the Runtime_State allocator the names were cloned through.
host_natives_release_context :: proc(ctx: jsc.JSContextRef, alloc: mem.Allocator) {
	if len(g_host_native_fns) == 0 do return
	// Collect first: deleting from a map while ranging over it is not defined.
	doomed := make([dynamic]Host_Native_Key, 0, len(g_host_native_fns), context.temp_allocator)
	for key in g_host_native_fns {
		if key.ctx == rawptr(ctx) do append(&doomed, key)
	}
	for key in doomed {
		fn := g_host_native_fns[key]
		// Through the shared helper, NOT a raw JSValueUnprotect: it skips the
		// unprotect on Windows on purpose (final teardown races the VM's GC/JIT
		// workers and exits 127; the VM is intentionally leaked there anyway).
		// Dropping the table entries and the owned names is still correct on
		// every platform — only the root release is Windows-conditional.
		unprotect_before_eval_exit(ctx, jsc.JSValueRef(fn))
		delete_key(&g_host_native_cbs, rawptr(fn))
		delete_key(&g_host_native_fns, key)
		delete(key.name, alloc)
	}
}
