package jsc

import "core:c"

// lava_jsc_init configures JavaScriptCore once before the first
// JSGlobalContextCreate: on Windows it disables the baseline JIT tier (broken in
// this bun-webkit build — see the .cpp) and runs JSC's process bring-up
// (WTF::initializeMainThread + JSC::initialize). Without it, heavy JS corrupts
// memory mid-execution (0xC0000409). The implementation is in build/jsc_init.lib
// (scripts/build-jsc-init-windows.sh, from pkg/jsc/jsc_init_windows.cpp) and is
// idempotent. No-op on Linux/macOS — so callers can invoke it unconditionally.
//
// make_uint8_nocopy_locked wraps JSObjectMakeTypedArrayWithBytesNoCopy in a
// JSLockHolder so the VM is entered (correct atom-string table) when a Uint8Array
// is created from native code that is NOT already inside a JSC callback — e.g. the
// fetch streaming body, driven straight from the event loop. The C-API typed-array
// creators do not self-lock, so without this a GC during the allocation aborts
// (see the .cpp). Use it for any native Uint8Array creation reachable from the
// loop. On Linux/macOS the dynamic JSC does not hit the abort, so the helper falls
// back to the plain C-API call.
when ODIN_OS == .Windows {
	foreign import jsc_init_lib "system:jsc_init.lib"

	@(default_calling_convention = "c", link_prefix = "")
	foreign jsc_init_lib {
		lava_jsc_init :: proc() ---
		lava_make_uint8_nocopy :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef ---
	}

	make_uint8_nocopy_locked :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef {
		return lava_make_uint8_nocopy(ctx, bytes, length, dealloc)
	}
} else when ODIN_OS == .Linux {
	// Disable JavaScriptCore's baseline JIT tier on Linux — the SAME broken tier the
	// Windows shim disables (see jsc_init_windows.cpp). In this bun-webkit build the
	// baseline tier's generated code corrupts the heap under sustained load: the node:http
	// server at ~50 concurrent connections aborts the process (SIGABRT) intermittently,
	// surfacing downstream in the GC marker (JSC::MarkedBlock::aboutToMarkSlow) once the
	// corrupted heap is walked. It is a textbook Heisenbug — only at high concurrency, and
	// it vanishes under AddressSanitizer (whose slowdown hides it) — and it is the JIT, not
	// the GC: disabling concurrent/parallel GC does nothing, but disabling this one tier
	// makes the crash 0/10 reproducible while keeping the optimizing pipeline (LLInt → DFG
	// → FTL), so throughput is barely affected (unlike useJIT=false). This build has the
	// JSC_ env-var option overrides compiled out (JSC_dumpOptions prints nothing), so we
	// set it via the exported JSC::Options::setOption; jsc_initialize() first so Options is
	// live and the override is not reset, and it all runs before the first
	// JSGlobalContextCreate (lava_jsc_init is called ahead of it in runtime.odin).
	lava_jsc_init :: proc() {
		jsc_initialize()
		jsc_options_set("useBaselineJIT=false", true)
	}

	make_uint8_nocopy_locked :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef {
		return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, bytes, length, dealloc, nil, nil)
	}
} else {
	lava_jsc_init :: proc() {}

	make_uint8_nocopy_locked :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef {
		return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, bytes, length, dealloc, nil, nil)
	}
}
