// Linux-only: uses the shared JSC-context helpers from
// host_native_registry_test.odin, which are compiled for Linux only (the
// private-ABI host path they gate on does not exist elsewhere).
#+build linux
package main

import "core:testing"
import jsc "lava:pkg/jsc"
import lava "lava:pkg/runtime"

// Pins module_cache_insert_new's rollback (globals.odin): when the map grow
// fails, the cloned key is freed and the JSValueProtect undone. Reverting the
// rollback to a bare `m[k] = v` leaves the same observable state (no entry), so
// the assertion below is only half the test — the other half is the runner's
// per-test tracking allocator, which reports the leaked key clone the moment
// the rollback is gone.
//
// The injection swaps the MAP, not state.allocator: a map captures its backing
// allocator at make time, so a zero-valued map with `allocator` pre-set is the
// one shape whose very first insert must grow through the failing allocator.
// The key clone itself still goes through state.allocator (the tracking one),
// which is exactly what makes a leaked clone visible.
@(test)
module_cache_insert_rolls_back_on_grow_failure :: proc(t: ^testing.T) {
	c, ok := make_context()
	testing.expect(t, ok, "could not create a JSC global context")
	if !ok do return
	defer destroy_context(c)

	state := lava.new_runtime_state(nil)
	defer lava.destroy_runtime_state(c.ctx, state)

	saved := state.module_cache
	state.module_cache = {}
	state.module_cache.allocator = failing_allocator()
	// Restored before teardown (defers are LIFO): destroy_runtime_state walks and
	// deletes the map, and it must be the one the real allocator owns.
	defer state.module_cache = saved

	value := jsc.JSValueMakeNumber(c.ctx, 1)
	lava.module_cache_put(c.ctx, state, "rollback-probe", value)

	_, hit := lava.module_cache_get(state, "rollback-probe")
	testing.expect(t, !hit, "an entry landed in a map whose grow failed")
}
