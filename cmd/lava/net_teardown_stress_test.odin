// Linux-only: net's native connect path (linux.socket) exists only there.
#+build linux
package main

import "core:mem"
import "core:testing"
import eventloop "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

// net_shutdown_active iterates state.net_conns directly while net_maybe_free
// delete_keys entries under it. Every clean script closes its sockets, so the
// sweep normally runs over an empty map and the delete-during-iteration shape
// goes unexercised — the smokes only reach it on timing luck. This pins it
// deterministically: net.connect inserts the connection at INITIATION
// (net.odin, state.net_conns[conn.id] = conn), and a top-level throw returns
// from eval before the loop ever runs, so teardown sweeps a map holding three
// live in-flight connections. The tracking allocator turns a mis-freed or
// skipped conn into a bad-free/leak report; a relocation bug in the iteration
// would surface as a crash. No listener and no port bind: the connects target
// a loopback port nothing answers, and their failure would only ever arrive
// through the loop, which never runs.
@(test)
eval_teardown_with_live_net_connections :: proc(t: ^testing.T) {
	track: mem.Tracking_Allocator
	mem.tracking_allocator_init(&track, context.allocator)
	defer mem.tracking_allocator_destroy(&track)
	context.allocator = mem.tracking_allocator(&track)

	loop := eventloop.init()
	src := `
		const net = require('node:net');
		net.connect(1, '127.0.0.1');
		net.connect(1, '127.0.0.1');
		net.connect(1, '127.0.0.1');
		throw new Error('teardown with live connections');
	`
	// eval CONSUMES the loop — it destroys it on every path, including this
	// top-level-throw one (see the OWNERSHIP note in runtime.odin).
	result := lava.eval(src, "<net-teardown-stress-test>", &loop, false)
	lava.result_destroy(&result)

	testing.expectf(
		t,
		len(track.bad_free_array) == 0,
		"teardown with live connections recorded %d bad free(s)",
		len(track.bad_free_array),
	)
}
