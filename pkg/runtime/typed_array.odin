package lava_runtime

import "base:runtime"
import "core:c"
import "core:mem"
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

// MAX_UNINIT_ALLOC caps the native uninitialized fast-path. Above it the JS layer
// falls back to a plain `new Buffer(size)`. The cap exists for safety, not policy:
// JavaScriptCore's NoCopy typed-array creator RELEASE_ASSERT-aborts the process for
// byte lengths past an internal limit (empirically between 4 and 8 GiB on the Linux
// build, and the Windows/macOS JSC builds may differ), whereas the JS typed-array
// constructor instead throws a catchable RangeError. 2 GiB-1 sits well below any of
// those abort thresholds, comfortably above any realistic allocUnsafe, and keeps
// behavior identical across Linux, macOS, and Windows. A request larger than this
// is rare and simply takes the safe (zero-filled) own-backing path, exactly as
// before this fast-path existed.
MAX_UNINIT_ALLOC :: 0x7fff_ffff // 2^31 - 1 bytes

// make_uint8_array_uninit hands JavaScriptCore `size` bytes of freshly allocated,
// *uninitialized* memory as a NoCopy Uint8Array. It backs the node:buffer unpooled
// unsafe-allocation paths — large Buffer.allocUnsafe, Buffer.allocUnsafeSlow, and
// SlowBuffer — for which Node returns memory as-is. A JS `new Uint8Array(size)`
// cannot reproduce that because every ArrayBuffer is zero-initialized; this
// deliberately skips the zero-fill (alloc_bytes_non_zeroed, not make), so the bytes
// hold whatever was previously in the region, like Node's malloc-not-calloc
// allocator. Ownership matches make_uint8_array exactly: the region comes from
// context.allocator and jsc_buffer_deallocator frees it once JSC collects the
// backing ArrayBuffer, so any view kept by the JS layer (the Buffer wrapper, a
// subarray, …) keeps the memory live for precisely as long as it is reachable —
// no leak, no use-after-free, no double-free. Returns ok=false for a non-positive
// or over-cap size, or an allocation failure, letting the caller fall back to a
// safe zero-filled own-backing Buffer (which still throws for an impossible size,
// as Node does).
make_uint8_array_uninit :: proc(ctx: jsc.JSContextRef, size: int) -> (jsc.JSValueRef, bool) {
	if size <= 0 || size > MAX_UNINIT_ALLOC do return nil, false
	data, err := mem.alloc_bytes_non_zeroed(size, mem.DEFAULT_ALIGNMENT, context.allocator)
	if err != nil || len(data) != size do return nil, false
	array := jsc.make_uint8_nocopy_locked(ctx, raw_data(data), c.size_t(size), jsc_buffer_deallocator)
	if array == nil {
		free(raw_data(data)) // hand-off failed: free the region ourselves, don't leak it
		return nil, false
	}
	return cast(jsc.JSValueRef)array, true
}
