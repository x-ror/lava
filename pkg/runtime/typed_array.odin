package lava_runtime

import "base:runtime"
import "core:c"
import jsc "lava:pkg/jsc"

// Shared JavaScriptCore <-> Odin TypedArray marshalling helpers. These are general
// purpose — used by the node:crypto, node:buffer, node:fs, node:sqlite and fetch
// bindings — so they live here rather than in whichever module happened to need
// them first (historically node:crypto). Everything is package-scoped, so callers
// reference them unqualified.

// typed_array_view borrows the backing store of a TypedArray or DataView as an
// Odin byte slice. The slice aliases JavaScriptCore-owned memory: valid only
// for the duration of the native call, never stored or freed. A zero-length
// array yields an empty slice (ok=true).
//
// The data start is computed as the ArrayBuffer's base pointer plus the view's
// byteOffset rather than JSObjectGetTypedArrayBytesPtr, which on javascriptcoregtk
// returns the buffer base and ignores the offset (so an offset view — e.g.
// `buffer.subarray(8)` — was read/written at the wrong position; see issue #68).
// base + byteOffset is correct regardless of whether a given JSC applies the
// offset to BytesPtr, so this stays right across backends.
typed_array_view :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> ([]byte, bool) {
	if jsc.JSValueGetTypedArrayType(ctx, value, nil) == .None do return nil, false
	obj := cast(jsc.JSObjectRef)value
	n := int(jsc.JSObjectGetTypedArrayByteLength(ctx, obj, nil))
	if n == 0 do return nil, true
	buffer := jsc.JSObjectGetTypedArrayBuffer(ctx, obj, nil)
	if buffer == nil do return nil, false
	base := jsc.JSObjectGetArrayBufferBytesPtr(ctx, buffer, nil)
	if base == nil do return nil, false
	offset := int(jsc.JSObjectGetTypedArrayByteOffset(ctx, obj, nil))
	return (cast([^]byte)base)[offset:][:n], true
}

// jsc_buffer_deallocator frees a heap-allocated (context.allocator) byte slice
// that was handed to JavaScriptCore as the NoCopy backing of a Uint8Array (see
// make_uint8_array). JSC invokes it on the array's collection. Used by fs/sqlite
// for their owned result buffers too.
jsc_buffer_deallocator :: proc "c" (bytes: rawptr, deallocator_context: rawptr) {
	context = runtime.default_context()
	if bytes != nil do free(bytes)
}

// make_uint8_array hands a heap-allocated (context.allocator) byte slice to
// JavaScriptCore as a Uint8Array without copying; jsc_buffer_deallocator frees it
// when the array is collected. A nil backing pointer (an empty `make`) is
// substituted with a 1-byte allocation reported as length 0, since JSC rejects a
// null pointer — decoders can legitimately yield zero bytes (e.g. hex of an
// invalid first pair).
make_uint8_array :: proc(ctx: jsc.JSContextRef, data: []byte) -> jsc.JSValueRef {
	ptr := raw_data(data)
	n := len(data)
	if ptr == nil {
		pad := make([]byte, 1, context.allocator)
		ptr = raw_data(pad)
		n = 0
	}
	// Enter the VM (JSLockHolder) around the creation: the C-API typed-array
	// creators do not self-lock, so when this runs from native code that is not
	// already inside a JSC callback (e.g. fetch's streaming body, driven from the
	// event loop), a GC triggered by the allocation would abort on Windows. The
	// helper is a recursive no-op for callers already holding the lock, and a plain
	// C-API call on Linux/macOS. See pkg/jsc/jsc_init.odin.
	array := jsc.make_uint8_nocopy_locked(ctx, ptr, c.size_t(n), jsc_buffer_deallocator)
	return cast(jsc.JSValueRef)array
}
