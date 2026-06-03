package lava_runtime

import "base:runtime"
import "core:c"
import "core:crypto"
import "core:crypto/hash"
import "core:crypto/hmac"
import "core:crypto/pbkdf2"
import jsc "lava:pkg/jsc"

// Native backing for the node:crypto built-in. The JavaScript surface
// (createHash/createHmac/randomBytes/pbkdf2/...) lives in js/internal/crypto.js
// and consults these primitives through the `native` bindings object the loader
// passes as the factory's fourth argument — the same pattern `console` uses to
// receive its write primitives without exposing them on globalThis.
//
// Entropy comes from crypto.rand_bytes (the OS CSPRNG: getentropy on Darwin,
// getrandom on Linux, BCryptGenRandom on Windows), replacing the Math.random
// placeholder the pure-JS module shipped with.

// crypto_algorithm maps a Node digest name (already lowercased by the JS layer)
// to an Odin hash.Algorithm. The bool is false for names we do not implement.
crypto_algorithm :: proc(name: string) -> (hash.Algorithm, bool) {
	switch name {
	case "md5":
		return .Insecure_MD5, true
	case "sha1":
		return .Insecure_SHA1, true
	case "sha224":
		return .SHA224, true
	case "sha256":
		return .SHA256, true
	case "sha384":
		return .SHA384, true
	case "sha512":
		return .SHA512, true
	case "sha512-256":
		return .SHA512_256, true
	case "sha3-224":
		return .SHA3_224, true
	case "sha3-256":
		return .SHA3_256, true
	case "sha3-384":
		return .SHA3_384, true
	case "sha3-512":
		return .SHA3_512, true
	}
	return .Invalid, false
}

// typed_array_view borrows the backing store of a Uint8Array (or Buffer, which
// subclasses it) as an Odin slice. The slice aliases JavaScriptCore-owned
// memory: valid only for the duration of the native call, never stored or
// freed. A zero-length array yields an empty slice (ok=true).
typed_array_view :: proc(ctx: jsc.JSContextRef, value: jsc.JSValueRef) -> ([]byte, bool) {
	if jsc.JSValueGetTypedArrayType(ctx, value, nil) == .None do return nil, false
	obj := cast(jsc.JSObjectRef)value
	n := int(jsc.JSObjectGetTypedArrayLength(ctx, obj, nil))
	if n == 0 do return nil, true
	ptr := jsc.JSObjectGetTypedArrayBytesPtr(ctx, obj, nil)
	if ptr == nil do return nil, false
	return (cast([^]byte)ptr)[:n], true
}

// make_uint8_array hands a heap-allocated (context.allocator) byte slice to
// JavaScriptCore as a Uint8Array without copying; fs_buffer_deallocator frees it
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
	array := jsc.JSObjectMakeTypedArrayWithBytesNoCopy(
		ctx,
		.Uint8Array,
		ptr,
		c.size_t(n),
		fs_buffer_deallocator,
		nil,
		nil,
	)
	return cast(jsc.JSValueRef)array
}

// randomFill(typedArray) — fill the array in place with CSPRNG bytes and return
// it. Used by randomBytes/randomFillSync/randomUUID. Writing through the
// borrowed view mutates the caller's Buffer/Uint8Array directly.
crypto_random_fill_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 1 do return jsc.JSValueMakeUndefined(ctx)

	view, ok := typed_array_view(ctx, arguments[0])
	if !ok {
		if exception != nil {
			exception^ = make_js_error(ctx, "randomFill expects a Uint8Array")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}
	if len(view) > 0 do crypto.rand_bytes(view)
	return arguments[0]
}

// hash(algorithm, data) — one-shot digest. The JS layer accumulates update()
// chunks and concatenates them into `data` before calling here, so streaming
// state never has to cross the boundary.
crypto_hash_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 2 do return jsc.JSValueMakeUndefined(ctx)

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc do delete(name, context.allocator)

	algo, valid := crypto_algorithm(name)
	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	data, ok := typed_array_view(ctx, arguments[1])
	if !ok {
		if exception != nil do exception^ = make_js_error(ctx, "hash expects a Uint8Array")
		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, hash.DIGEST_SIZES[algo], context.allocator)
	hash.hash_bytes_to_buffer(algo, data, dst)
	return make_uint8_array(ctx, dst)
}

// hmac(algorithm, key, data) — one-shot HMAC, mirroring crypto_hash_cb.
crypto_hmac_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 3 do return jsc.JSValueMakeUndefined(ctx)

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc do delete(name, context.allocator)

	algo, valid := crypto_algorithm(name)
	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	key, key_ok := typed_array_view(ctx, arguments[1])
	data, data_ok := typed_array_view(ctx, arguments[2])
	if !key_ok || !data_ok {
		if exception != nil do exception^ = make_js_error(ctx, "hmac expects Uint8Array key and data")
		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, hash.DIGEST_SIZES[algo], context.allocator)
	hmac.sum(algo, dst, data, key)
	return make_uint8_array(ctx, dst)
}

// pbkdf2(algorithm, password, salt, iterations, keylen) — derive `keylen` bytes.
crypto_pbkdf2_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 5 do return jsc.JSValueMakeUndefined(ctx)

	name, alloc := jsc_value_to_string_or_default(ctx, arguments[0])
	defer if alloc do delete(name, context.allocator)

	algo, valid := crypto_algorithm(name)
	if !valid {
		if exception != nil {
			exception^ = make_js_error(ctx, "Digest method not supported")
		}
		return jsc.JSValueMakeUndefined(ctx)
	}

	password, pw_ok := typed_array_view(ctx, arguments[1])
	salt, salt_ok := typed_array_view(ctx, arguments[2])
	if !pw_ok || !salt_ok {
		if exception != nil do exception^ = make_js_error(ctx, "pbkdf2 expects Uint8Array password and salt")
		return jsc.JSValueMakeUndefined(ctx)
	}

	iterations := u32(jsc.JSValueToNumber(ctx, arguments[3], nil))
	keylen := int(jsc.JSValueToNumber(ctx, arguments[4], nil))
	if iterations == 0 || keylen <= 0 {
		if exception != nil do exception^ = make_js_error(ctx, "pbkdf2 requires positive iterations and keylen")
		return jsc.JSValueMakeUndefined(ctx)
	}

	dst := make([]byte, keylen, context.allocator)
	pbkdf2.derive(algo, password, salt, iterations, dst)
	return make_uint8_array(ctx, dst)
}

// make_crypto_bindings builds the `native` object handed to js/internal/crypto.js.
make_crypto_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "randomFill", crypto_random_fill_cb)
	inject_native_function(ctx, bindings, "hash", crypto_hash_cb)
	inject_native_function(ctx, bindings, "hmac", crypto_hmac_cb)
	inject_native_function(ctx, bindings, "pbkdf2", crypto_pbkdf2_cb)
	return bindings
}
