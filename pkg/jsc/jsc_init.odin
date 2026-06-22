package jsc

import "core:c"
import "core:sync"

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
	// Run JavaScriptCore's full process bring-up (WTF main thread, JIT + GC marker threads,
	// executable-memory allocator, Options finalize) before the first JSGlobalContextCreate.
	// The bare C API does NOT do this: JSGlobalContextCreate only lazily inits a minimal
	// subset at first VM touch — the SAME gap the Windows static build hits (see
	// jsc_init_windows.cpp). The old comment claimed "Linux is unaffected because the dylib
	// self-initializes"; that is wrong. Without this, under sustained load (the node:http
	// server at ~50 concurrent connections) the baseline JIT and GC marker threads run on
	// half-initialized engine state and corrupt the heap, aborting the process (SIGABRT,
	// surfacing downstream in JSC::MarkedBlock::aboutToMarkSlow on a GC thread). It is a
	// textbook Heisenbug — only at high concurrency, and it vanishes under AddressSanitizer.
	// Calling JSC::initialize() fixes it at the root (verified 0/N crashes) while keeping the
	// FULL JIT pipeline (LLInt -> baseline -> DFG -> FTL) — far better than the blunt
	// useJIT/useBaselineJIT=false workarounds, which only dodge the half-initialized path.
	//
	// Guarded by sync.Once: the Odin test runner calls lava_jsc_init from many parallel
	// @(test) threads, each then creating its own VM, so the bring-up must run exactly once
	// and before any VM — the guard blocks the other callers until it has. Mirrors the
	// std::call_once in the Windows shim.
	@(private = "file")
	jsc_init_once: sync.Once

	lava_jsc_init :: proc() {
		sync.once_do(&jsc_init_once, proc() {
			jsc_initialize()
		})
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
