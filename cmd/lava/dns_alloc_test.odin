#+build linux, darwin
package main

import "core:mem"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

// Guards the localized dns/fetch allocator fix (Dns_Lookup_Request.allocator). The
// hostname is cloned inside the native dns lookup callback (a `proc "c"` where context
// resets to runtime.default_context — the heap allocator) and the request struct is
// new()'d there too, but both are freed later in dns_request_free under the loop/
// teardown context. The runtime now captures the owning state.allocator on the request
// and clones/frees through it, so the pair agrees even when eval runs under a custom
// allocator. Here that caller is a tracking allocator: an IP-literal lookup forces the
// clone+free without any network (the worker resolves "127.0.0.1" as a literal), so a
// mismatched free would land in bad_free_array. Scoped linux+darwin, where eval links JSC.
@(test)
eval_dns_lookup_uses_consistent_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	// An IP-literal lookup runs the full async path — native clone, worker resolve,
	// completion, dns_request_free — without touching the network. eval CONSUMES the
	// loop (it destroys it on every path; see the OWNERSHIP note in runtime.odin), so
	// there is no separate eventloop.destroy here.
	src := "require('node:dns').lookup('127.0.0.1', () => {}); 0"
	result := lava.eval(src, "<dns-alloc-test>", &loop, false)
	lava.result_destroy(&result)

	// A bad free here is the dns request allocator mismatch this fix targets; it would
	// also catch any other eval-time allocation freed with the wrong allocator.
	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"eval of a dns lookup under a tracking allocator recorded %d bad free(s)",
		len(track.bad_free_array),
	)
}
