package lava_runtime

import "base:runtime"
import "core:c"
import "core:net"
import "core:strings"
import "core:thread"
import jsc "lava:pkg/jsc"
import eventloop "lava:pkg/runtime/eventloop"

// node:dns bridge — Tier 1 (lookup). js/internal/dns.js implements the public
// dns / dns.promises surface on top of these native primitives; the actual name
// resolution is the OS resolver (getaddrinfo) via core:net, run off the event
// loop on a worker thread so a slow lookup never blocks the loop. This mirrors
// the fetch DNS hand-off (fetch_transport.odin): async_begin keeps the loop
// alive, the worker posts a completion back via post_async, and the completion
// (loop thread) builds the JS result and invokes the user callback.
//
// The record-type queries (resolve4/resolveMx/…) and reverse/lookupService are
// Tier 2 and live behind c-ares (see pkg/std/cares) — not in this file.

// Odin's core:net resolve_ip4/ip6 each return a single endpoint, so a lookup
// yields at most one A and one AAAA address (vs Node's full list). Good enough
// for lookup(); the c-ares getaddrinfo path in Tier 2 returns full lists.
DNS_LOOKUP_MAX :: 2

Dns_Lookup_Result :: struct {
	addr:   net.Address, // IP4_Address | IP6_Address
	family: int, // 4 or 6
}

// Dns_Lookup_Request is heap-allocated by dns_lookup_cb and lives until the
// completion fires. The worker thread writes results/ok/err_code; post_async's
// lock publishes those writes to the loop thread that reads them.
Dns_Lookup_Request :: struct {
	ctx:      jsc.JSContextRef,
	loop:     ^eventloop.Loop,
	callback: jsc.JSObjectRef, // GC-protected JS callback(errCode|null, addresses|null)
	hostname: string, // owned clone (the worker reads it off-loop)
	family:   int, // 0 (any) | 4 | 6
	all:      bool,
	worker:   ^thread.Thread,
	results:  [DNS_LOOKUP_MAX]Dns_Lookup_Result,
	n:        int,
	ok:       bool,
	err_code: string, // static literal, e.g. "ENOTFOUND"
}

// make_dns_bindings builds the `native` object handed to js/internal/dns.js.
make_dns_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "lookup", dns_lookup_cb)
	return bindings
}

// dns_lookup_cb(hostname, family, all, callback) — kicks off an async getaddrinfo.
// family is 0/4/6; all selects single vs full result. The JS callback is invoked
// later as callback(errCode|null, [{address, family}, ...]).
dns_lookup_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 4 {
		if exception != nil do exception^ = make_js_error(ctx, "dns lookup requires (hostname, family, all, callback)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]

	callback := callback_arg(ctx, args[3])
	if callback == nil {
		if exception != nil do exception^ = make_js_error(ctx, "dns lookup callback must be a function")
		return jsc.JSValueMakeUndefined(ctx)
	}

	loop := get_loop_from_ctx(ctx)
	if loop == nil {
		if exception != nil do exception^ = make_js_error(ctx, "dns: no event loop is bound to this context")
		return jsc.JSValueMakeUndefined(ctx)
	}

	hostname, host_alloc := jsc_value_to_string_or_default(ctx, args[0])
	defer if host_alloc do delete(hostname, context.allocator)

	req := new(Dns_Lookup_Request)
	req.ctx = ctx
	req.loop = loop
	req.callback = callback
	req.hostname = strings.clone(hostname) // the worker reads this off-loop
	req.family = int(jsc.JSValueToNumber(ctx, args[1], nil))
	req.all = jsc.JSValueToBoolean(ctx, args[2])

	jsc.JSValueProtect(ctx, cast(jsc.JSValueRef)callback)

	// async_begin must precede the spawn (the worker may post before this
	// returns); on a spawn failure we undo it, or the loop blocks forever.
	eventloop.async_begin(loop)
	worker := thread.create_and_start_with_data(req, dns_lookup_worker, nil, .Normal, false)
	if worker == nil {
		eventloop.async_cancel(loop)
		jsc.JSValueUnprotect(ctx, cast(jsc.JSValueRef)callback)
		delete(req.hostname)
		free(req)
		if exception != nil do exception^ = make_js_error(ctx, "dns: could not start resolver thread")
		return jsc.JSValueMakeUndefined(ctx)
	}
	req.worker = worker
	return jsc.JSValueMakeUndefined(ctx)
}

// dns_lookup_worker runs off the loop: it resolves the host (blocking
// getaddrinfo), stashes the results on the request, and posts the completion.
// It must not touch JSC (single-threaded) or the request after post_async.
dns_lookup_worker :: proc(data: rawptr) {
	req := cast(^Dns_Lookup_Request)data
	n := 0
	want4 := req.family == 0 || req.family == 4
	want6 := req.family == 0 || req.family == 6

	if want4 {
		if ep, err := net.resolve_ip4(req.hostname); err == nil {
			if v4, is4 := ep.address.(net.IP4_Address); is4 {
				req.results[n] = {addr = v4, family = 4}
				n += 1
			}
		}
	}
	// For a single-address lookup with family unspecified, only fall back to
	// AAAA when no A record was found; `all` collects both.
	if want6 && (req.all || n == 0) {
		if ep, err := net.resolve_ip6(req.hostname); err == nil {
			if v6, is6 := ep.address.(net.IP6_Address); is6 {
				req.results[n] = {addr = v6, family = 6}
				n += 1
			}
		}
	}

	req.n = n
	req.ok = n > 0
	if !req.ok do req.err_code = "ENOTFOUND"

	free_all(context.temp_allocator) // release this worker's resolver scratch
	eventloop.post_async(req.loop, dns_lookup_complete_cb, req)
}

// dns_lookup_complete_cb runs on the loop thread once resolution finishes: it
// builds the JS result and invokes the callback. Reading req.* here is safe —
// post_async published the worker's writes.
dns_lookup_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	req := cast(^Dns_Lookup_Request)user_data
	ctx := req.ctx

	code_val, addrs_val: jsc.JSValueRef
	if req.ok {
		code_val = jsc.JSValueMakeNull(ctx)
		objs := make([]jsc.JSValueRef, req.n, context.temp_allocator)
		for i in 0 ..< req.n {
			o := jsc.JSObjectMake(ctx, nil, nil)
			s := net.address_to_string(req.results[i].addr, context.temp_allocator)
			set_named(ctx, o, "address", js_string_value(ctx, s))
			set_named(ctx, o, "family", jsc.JSValueMakeNumber(ctx, f64(req.results[i].family)))
			objs[i] = cast(jsc.JSValueRef)o
		}
		addrs_val = cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(req.n), raw_data(objs), nil)
	} else {
		code_val = js_string_value(ctx, req.err_code)
		addrs_val = jsc.JSValueMakeNull(ctx)
	}

	cb_args := [2]jsc.JSValueRef{code_val, addrs_val}
	exception: jsc.JSValueRef
	invoke_user_callback(ctx, req.callback, raw_data(cb_args[:]), 2, &exception)
	if exception != nil {
		report_uncaught(ctx, exception)
		mark_async_failed(ctx)
	}
	dns_lookup_finish(req)
}

// dns_lookup_finish joins the worker, releases the protected callback, and frees
// the request. Loop thread only; safe once the completion has run.
dns_lookup_finish :: proc(req: ^Dns_Lookup_Request) {
	if req.worker != nil {
		thread.join(req.worker)
		thread.destroy(req.worker)
		req.worker = nil
	}
	if req.callback != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
		req.callback = nil
	}
	delete(req.hostname)
	free(req)
}
