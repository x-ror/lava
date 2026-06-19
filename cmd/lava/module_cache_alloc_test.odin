#+build linux, darwin
package main

import "core:mem"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

// Guards the module_cache key-allocator fix. Cache keys are cloned inside the native
// require callback (a `proc "c"` where context resets to runtime.default_context — the
// heap allocator) but freed later in destroy_runtime_state under the caller's context.
// The runtime now clones/frees them through an explicit state.allocator, so the two
// agree even when the caller runs eval under a custom allocator. Here that caller is a
// tracking allocator: requiring a module forces a key clone, and a mismatched free
// would land in bad_free_array. (Before the fix this recorded a bad free at
// globals.odin's module_cache teardown.) Scoped linux+darwin, where eval links JSC.
@(test)
eval_module_cache_keys_use_consistent_allocator :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	// require() forces a module_cache key clone inside the native require callback;
	// eval's teardown then frees it. Both must use the captured state.allocator.
	result := lava.eval("require('node:events'); 0", "<module-cache-alloc-test>", &loop, false)
	lava.result_destroy(&result)

	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"module_cache freed a key with the wrong allocator: %d bad free(s)",
		len(track.bad_free_array),
	)
}
