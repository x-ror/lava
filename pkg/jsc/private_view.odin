package jsc

import "core:c"

// Direct JSArrayBufferView reads. Resolving a typed array's bytes through the
// public C API costs 3–4 locked calls per native invocation (type check,
// length, bytes pointer, byte offset — plus the gtk byteOffset bug workaround,
// issue #68). The view cell itself holds everything needed: the JSCell type
// byte identifies a Uint8Array (any Structure — Buffer subclasses included),
// m_vector points at the view's first byte (base + byteOffset, always), and
// m_length is the element count.
//
// Nothing about the layout is hardcoded: at first use three Uint8Arrays are
// created over backing stores whose addresses and lengths we chose, and the
// field offsets are discovered by scanning the cells for those known values
// (the type byte's offset within the JSCell header — structureID u32,
// indexingType u8, type u8 — is the one fixed assumption, unchanged in JSC for
// many years). All three cells must agree or the fast path stays disabled and
// callers keep using the C API.

// JSCell header: [structureID u32][indexingTypeAndMisc u8][type u8][flags u8][cellState u8].
JSCELL_TYPE_OFFSET :: 5

// A 64-bit JSValueRef is the NaN-boxed JSValue bit pattern; a GC cell is an
// 8-aligned pointer with the top 16 bits clear, while every immediate
// (int32/double/undefined/null/booleans) has bits in this mask set. Used only
// as a conservative pre-filter before dereferencing — a false negative just
// means the C-API fallback.
VALUE_NOT_CELL_MASK :: u64(0xFFFF_0000_0000_0007)

// MAX_VIEW_LENGTH bounds a plausible Uint8Array length; a probed length above
// this can only be a mis-read cell field, so typed_array_bytes rejects it and
// the C API handles that value instead. Well above any real Buffer (JSC caps
// typed arrays far below 2^33).
MAX_VIEW_LENGTH :: 0x1_0000_0000

when ODIN_OS == .Linux {
	// Thread-local: probing must run on the (thread-confined) context that will
	// later be read, and the cell offsets — though a build-global fact — are
	// re-derived once per worker thread to avoid a shared latch being seen
	// half-published during concurrent worker startup.
	@(private = "file", thread_local) g_view_checked: bool
	@(private = "file", thread_local) g_view_ok: bool
	@(private = "file", thread_local) g_view_type: u8
	@(private = "file", thread_local) g_vec_off: uintptr
	@(private = "file", thread_local) g_len_off: uintptr
	@(private = "file", thread_local) g_len_u64: bool

	// Immortal backing stores for the probe views (nil deallocator): distinct
	// addresses and lengths so field offsets are identified by value. The `_off`
	// view (backed by g_probe_d, viewed at a non-zero byteOffset) disambiguates a
	// genuine 64-bit length from a 32-bit length whose adjacent (zero) field the
	// wide read would otherwise fold in — see ensure_view.
	@(private = "file", thread_local) g_probe_a: [40]byte
	@(private = "file", thread_local) g_probe_b: [24]byte
	@(private = "file", thread_local) g_probe_c: [56]byte
	@(private = "file", thread_local) g_probe_d: [64]byte

	@(private = "file")
	ensure_view :: proc(ctx: JSContextRef) {
		if g_view_checked do return
		// Soft failures (nil create) leave g_view_checked false so a later call
		// retries. Layout disagreements after successful allocates latch closed.

		a := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_a[0], len(g_probe_a), nil, nil, nil)
		if a == nil do return
		JSValueProtect(ctx, JSValueRef(a))
		defer JSValueUnprotect(ctx, JSValueRef(a))
		b := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_b[0], len(g_probe_b), nil, nil, nil)
		if b == nil do return
		JSValueProtect(ctx, JSValueRef(b))
		defer JSValueUnprotect(ctx, JSValueRef(b))
		cc := JSObjectMakeTypedArrayWithBytesNoCopy(ctx, .Uint8Array, &g_probe_c[0], len(g_probe_c), nil, nil, nil)
		if cc == nil do return
		JSValueProtect(ctx, JSValueRef(cc))
		defer JSValueUnprotect(ctx, JSValueRef(cc))

		pa, pb, pc := uintptr(rawptr(a)), uintptr(rawptr(b)), uintptr(rawptr(cc))
		ty := (^u8)(pa + JSCELL_TYPE_OFFSET)^
		if (^u8)(pb + JSCELL_TYPE_OFFSET)^ != ty || (^u8)(pc + JSCELL_TYPE_OFFSET)^ != ty {
			g_view_checked = true
			return
		}
		vec_off: uintptr
		vec_found := false
		for cand: uintptr = 8; cand <= 120; cand += 8 {
			if (^rawptr)(pa + cand)^ == rawptr(&g_probe_a[0]) &&
			   (^rawptr)(pb + cand)^ == rawptr(&g_probe_b[0]) &&
			   (^rawptr)(pc + cand)^ == rawptr(&g_probe_c[0]) {
				vec_off = cand
				vec_found = true
				break
			}
		}
		if !vec_found {
			g_view_checked = true
			return
		}

		// Length is size_t on 64-bit JSC builds with large typed arrays, u32 on
		// older ones — try the wider read first. byteOffset is 0 on all three
		// probe views, so it can never collide with these length values.
		len_off: uintptr
		len_found := false
		len_u64 := false
		for cand: uintptr = 8; cand <= 120; cand += 8 {
			if cand == vec_off do continue
			if (^u64)(pa + cand)^ == len(g_probe_a) &&
			   (^u64)(pb + cand)^ == len(g_probe_b) &&
			   (^u64)(pc + cand)^ == len(g_probe_c) {
				len_off = cand
				len_found = true
				len_u64 = true
				break
			}
		}
		if !len_found {
			for cand: uintptr = 8; cand <= 124; cand += 4 {
				if cand >= vec_off && cand < vec_off + 8 do continue
				if (^u32)(pa + cand)^ == len(g_probe_a) &&
				   (^u32)(pb + cand)^ == len(g_probe_b) &&
				   (^u32)(pc + cand)^ == len(g_probe_c) {
					len_off = cand
					len_found = true
					break
				}
			}
		}
		if !len_found {
			g_view_checked = true
			return
		}
		// Disambiguate the width with a view at a NON-ZERO byteOffset. All three
		// probes above have byteOffset 0, so if m_length is really u32 with an
		// adjacent u32 byteOffset, a u64 read at len_off equals the length anyway
		// (0 in the upper half) and len_u64 latches true wrongly. For a real
		// offset view the wide read would be length | (byteOffset<<32) — a huge
		// value. Build one (offset 16, length 32 over g_probe_d) and require the
		// chosen mode to read exactly 32 with m_vector == base+16; downgrade to
		// u32 (or disable) otherwise.
		{
			OFF :: 16
			LEN :: 32
			ab := JSObjectMakeArrayBufferWithBytesNoCopy(ctx, &g_probe_d[0], len(g_probe_d), nil, nil, nil)
			if ab == nil do return // soft
			JSValueProtect(ctx, JSValueRef(ab))
			defer JSValueUnprotect(ctx, JSValueRef(ab))
			global := JSContextGetGlobalObject(ctx)
			u8_name := JSStringCreateWithUTF8CString("Uint8Array")
			defer JSStringRelease(u8_name)
			u8_ctor := JSObjectGetProperty(ctx, global, u8_name, nil)
			if u8_ctor == nil || !JSValueIsObject(ctx, u8_ctor) {
				g_view_checked = true
				return
			}
			args := [3]JSValueRef {
				JSValueRef(ab),
				JSValueMakeNumber(ctx, f64(OFF)),
				JSValueMakeNumber(ctx, f64(LEN)),
			}
			ov := JSObjectCallAsConstructor(ctx, JSObjectRef(u8_ctor), 3, &args[0], nil)
			if ov == nil do return // soft
			JSValueProtect(ctx, JSValueRef(ov))
			defer JSValueUnprotect(ctx, JSValueRef(ov))
			pv := uintptr(rawptr(ov))
			if (^u8)(pv + JSCELL_TYPE_OFFSET)^ != ty {
				g_view_checked = true
				return
			}
			// m_vector already includes byteOffset.
			if (^rawptr)(pv + vec_off)^ != rawptr(&g_probe_d[OFF]) {
				g_view_checked = true
				return
			}
			read := len_u64 ? int((^u64)(pv + len_off)^) : int((^u32)(pv + len_off)^)
			if read != LEN {
				// Wide read folded in byteOffset; the field is really u32.
				if len_u64 && int((^u32)(pv + len_off)^) == LEN {
					len_u64 = false
				} else {
					g_view_checked = true
					return
				}
			}
		}

		g_view_type = ty
		g_vec_off = vec_off
		g_len_off = len_off
		g_len_u64 = len_u64
		g_view_ok = true
		g_view_checked = true
	}

	// typed_array_bytes borrows a Uint8Array's bytes straight from the view
	// cell — any Structure (Buffer subclass views included), byteOffset already
	// folded into the pointer. ok=false for non-Uint8Array values (other view
	// types, DataView, non-cells) and when the probe is unavailable; callers
	// fall back to the C API. The slice is valid only while the value is alive,
	// i.e. for the duration of the native call.
	typed_array_bytes :: proc(ctx: JSContextRef, value: JSValueRef) -> (data: []byte, ok: bool) {
		ensure_view(ctx)
		if !g_view_ok do return nil, false
		p := uintptr(value)
		if p == 0 || (u64(p) & VALUE_NOT_CELL_MASK) != 0 do return nil, false
		if (^u8)(p + JSCELL_TYPE_OFFSET)^ != g_view_type do return nil, false
		vec := (^rawptr)(p + g_vec_off)^
		n := g_len_u64 ? int((^u64)(p + g_len_off)^) : int((^u32)(p + g_len_off)^)
		if vec == nil || n < 0 {
			// Detached (or zero-length wasteful) views have a null vector and a
			// zeroed length; report those as a valid empty view.
			return nil, n == 0
		}
		// Defense in depth against a mis-probed length field: a real Uint8Array
		// never exceeds MAX_VIEW_LENGTH, so anything larger means the read is
		// bogus — fall back to the C API rather than hand out a wild slice.
		if n > MAX_VIEW_LENGTH do return nil, false
		return ([^]byte)(vec)[:n], true
	}
} else {
	typed_array_bytes :: proc(_: JSContextRef, _: JSValueRef) -> (data: []byte, ok: bool) {
		return nil, false
	}
}
