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
// resolution is core:net's DNS client (NOT the system getaddrinfo — core:net
// parses /etc/resolv.conf + /etc/hosts and speaks DNS itself), run off the event
// loop on a worker thread so a slow lookup never blocks the loop. This mirrors
// the fetch DNS hand-off (fetch_transport.odin): async_begin keeps the loop
// alive, the worker posts a completion back via post_async, and the completion
// (loop thread) builds the JS result and invokes the user callback.
//
// Because core:net is not getaddrinfo, the getaddrinfo hint flags (ADDRCONFIG,
// V4MAPPED) are validated in dns.js but have no behavioral effect here yet; the
// result `order` (verbatim/ipv4first/ipv6first) IS honored across the per-family
// queries below. The record-type queries (resolve4/resolveMx/…) and reverse/
// lookupService are Tier 2 and live behind c-ares (see pkg/std/cares).

// Result order codes shared with js/internal/dns.js (ORDER_CODES). Only the
// IPv6-first case changes which family we try first; verbatim and ipv4first both
// try IPv4 first (core:net has no single interleaved OS order to preserve).
ORDER_VERBATIM :: 0
ORDER_IPV4FIRST :: 1
ORDER_IPV6FIRST :: 2

Dns_Lookup_Result :: struct {
	addr:   net.Address, // IP4_Address | IP6_Address
	family: int, // 4 or 6
}

// Dns_Lookup_Request is heap-allocated by dns_lookup_cb and lives until the
// completion fires (or until eval teardown joins the worker and frees it early —
// see dns_shutdown_active). The worker thread writes results/ok/err_code;
// post_async's lock publishes those writes to the loop thread that reads them.
Dns_Lookup_Request :: struct {
	ctx:      jsc.JSContextRef,
	loop:     ^eventloop.Loop,
	callback: jsc.JSObjectRef, // GC-protected JS callback(errCode|null, addresses|null)
	hostname: string, // owned clone (the worker reads it off-loop)
	family:   int, // 0 (any) | 4 | 6
	order:    int, // ORDER_* (which family to prefer / how to concatenate)
	all:      bool,
	worker:   ^thread.Thread,
	results:  [dynamic]Dns_Lookup_Result, // heap (default allocator); full address list
	ok:       bool,
	err_code: string, // static literal, e.g. "ENOTFOUND"
}

// make_dns_bindings builds the `native` object handed to js/internal/dns.js.
make_dns_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	bindings := jsc.JSObjectMake(ctx, nil, nil)
	inject_native_function(ctx, bindings, "lookup", dns_lookup_cb)
	return bindings
}

// dns_lookup_cb(hostname, family, order, all, callback) — kicks off an async
// resolve. family is 0/4/6; order is ORDER_*; all selects single vs full result.
// The JS callback is invoked later as callback(errCode|null, [{address, family}, ...]).
dns_lookup_cb :: proc "c" (
	ctx: jsc.JSContextRef,
	function: jsc.JSObjectRef,
	this_object: jsc.JSObjectRef,
	argument_count: c.size_t,
	arguments: [^]jsc.JSValueRef,
	exception: ^jsc.JSValueRef,
) -> jsc.JSValueRef {
	context = runtime.default_context()
	if argument_count < 5 {
		if exception != nil do exception^ = make_js_error(ctx, "dns lookup requires (hostname, family, order, all, callback)")
		return jsc.JSValueMakeUndefined(ctx)
	}
	args := arguments[:int(argument_count)]

	callback := callback_arg(ctx, args[4])
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
	req.order = int(jsc.JSValueToNumber(ctx, args[2], nil))
	req.all = jsc.JSValueToBoolean(ctx, args[3])

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
	// Track the in-flight request so eval teardown can join the worker before the
	// loop/context die, even if a top-level throw skips eventloop.run entirely.
	dns_track_active(get_state_from_ctx(ctx), req)
	return jsc.JSValueMakeUndefined(ctx)
}

// dns_query_family resolves one address family for req.hostname and appends the
// matching records (all of them, or just the first when first_only). Mirrors
// core:net's resolve_ip4/ip6 host path — including the `.local` mDNS branch — but
// keeps the whole record list instead of collapsing to the first endpoint, so
// lookup(all:true) returns every address the resolver knows about. Worker thread.
dns_query_family :: proc(req: ^Dns_Lookup_Request, type: net.DNS_Record_Type, family: int, first_only: bool) {
	recs: []net.DNS_Record
	is_mdns := ODIN_OS != .Windows && strings.has_suffix(req.hostname, ".local")
	if is_mdns && type == .IP4 {
		recs, _ = net.get_dns_records_from_nameservers(req.hostname, .IP4, {net.IP4_mDNS_Broadcast}, nil, context.temp_allocator)
	} else if is_mdns {
		recs, _ = net.get_dns_records_from_nameservers(req.hostname, .IP6, {net.IP6_mDNS_Broadcast}, nil, context.temp_allocator)
	} else {
		recs, _ = net.get_dns_records_from_os(req.hostname, type, context.temp_allocator)
	}
	for rec in recs {
		addr: net.Address
		#partial switch r in rec {
		case net.DNS_Record_IP4:
			addr = r.address
		case net.DNS_Record_IP6:
			addr = r.address
		case:
			continue
		}
		append(&req.results, Dns_Lookup_Result{addr = addr, family = family})
		if first_only do break
	}
}

// dns_lookup_worker runs off the loop: it resolves the host, stashes the results
// on the request, and posts the completion. It must not touch JSC (single-
// threaded) or the request after post_async.
dns_lookup_worker :: proc(data: rawptr) {
	context = runtime.default_context()
	req := cast(^Dns_Lookup_Request)data

	// An IP literal resolves to itself with its own family, ignoring the requested
	// family — this is what getaddrinfo (AI_NUMERICHOST) and Node both do.
	if lit := net.parse_address(req.hostname); lit != nil {
		#partial switch a in lit {
		case net.IP4_Address:
			append(&req.results, Dns_Lookup_Result{addr = a, family = 4})
		case net.IP6_Address:
			append(&req.results, Dns_Lookup_Result{addr = a, family = 6})
		}
	} else {
		want4 := req.family == 0 || req.family == 4
		want6 := req.family == 0 || req.family == 6
		prefer6 := req.order == ORDER_IPV6FIRST
		if req.all {
			// Full enumeration of every requested family, concatenated per order.
			if prefer6 {
				if want6 do dns_query_family(req, .IP6, 6, false)
				if want4 do dns_query_family(req, .IP4, 4, false)
			} else {
				if want4 do dns_query_family(req, .IP4, 4, false)
				if want6 do dns_query_family(req, .IP6, 6, false)
			}
		} else {
			// Single address: first of the preferred family, else fall back. Querying
			// the preferred family first also avoids the second query in the common case.
			if prefer6 {
				if want6 do dns_query_family(req, .IP6, 6, true)
				if len(req.results) == 0 && want4 do dns_query_family(req, .IP4, 4, true)
			} else {
				if want4 do dns_query_family(req, .IP4, 4, true)
				if len(req.results) == 0 && want6 do dns_query_family(req, .IP6, 6, true)
			}
		}
	}

	req.ok = len(req.results) > 0
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
		n := len(req.results)
		objs := make([]jsc.JSValueRef, n, context.temp_allocator)
		for i in 0 ..< n {
			o := jsc.JSObjectMake(ctx, nil, nil)
			s := net.address_to_string(req.results[i].addr, context.temp_allocator)
			set_named(ctx, o, "address", js_string_value(ctx, s))
			set_named(ctx, o, "family", jsc.JSValueMakeNumber(ctx, f64(req.results[i].family)))
			objs[i] = cast(jsc.JSValueRef)o
		}
		addrs_val = cast(jsc.JSValueRef)jsc.JSObjectMakeArray(ctx, c.size_t(n), raw_data(objs), nil)
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

	if state := get_state_from_ctx(ctx); state != nil {
		dns_untrack_active(state, req)
	}
	dns_request_free(req)
}

// --- in-flight request tracking (teardown safety, mirrors active_fetches) ---

dns_track_active :: proc(state: ^Runtime_State, req: ^Dns_Lookup_Request) {
	if state == nil || req == nil do return
	append(&state.active_dns, req)
}

dns_untrack_active :: proc(state: ^Runtime_State, req: ^Dns_Lookup_Request) {
	if state == nil || req == nil do return
	for i in 0 ..< len(state.active_dns) {
		if state.active_dns[i] == req {
			// Membership-only bag (used for teardown); swap-remove in O(1).
			unordered_remove(&state.active_dns, i)
			return
		}
	}
}

// dns_request_free joins the worker, releases the protected callback (WITHOUT
// invoking it), and frees the request. Loop-thread only. The join is what makes
// teardown safe: it blocks until the worker has finished resolving and posted (or
// is about to), so no background thread can post into a destroyed loop. The posted
// completion, if any, is dropped by eventloop.destroy (post_async tasks have no
// dispose hook), and its now-dangling user_data is never dereferenced. Idempotent.
dns_request_free :: proc(req: ^Dns_Lookup_Request) {
	if req == nil do return
	if req.worker != nil {
		thread.join(req.worker)
		thread.destroy(req.worker)
		req.worker = nil
	}
	if req.callback != nil {
		jsc.JSValueUnprotect(req.ctx, cast(jsc.JSValueRef)req.callback)
		req.callback = nil
	}
	delete(req.results)
	delete(req.hostname)
	free(req)
}

// dns_shutdown_active joins and frees every in-flight lookup WITHOUT invoking its
// JS callback. Used while the JS context is still alive but eval is already
// returning (e.g. after a top-level throw that skips eventloop.run). Idempotent:
// each completed lookup has already untracked itself, so a second pass is empty.
dns_shutdown_active :: proc(state: ^Runtime_State) {
	if state == nil do return
	for len(state.active_dns) > 0 {
		req := pop(&state.active_dns) // untrack before freeing
		dns_request_free(req)
	}
}

// dns_destroy_state runs at context teardown: shut down anything still in flight
// and release the backing store.
dns_destroy_state :: proc(state: ^Runtime_State) {
	if state == nil do return
	dns_shutdown_active(state)
	delete(state.active_dns)
}
