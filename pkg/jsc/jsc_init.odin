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
} else {
	lava_jsc_init :: proc() {}

	make_uint8_nocopy_locked :: proc(ctx: JSContextRef, bytes: rawptr, length: c.size_t, dealloc: proc "c" (bytes: rawptr, deallocator_context: rawptr)) -> JSObjectRef {
		return JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, bytes, length, dealloc, nil, nil)
	}
}
