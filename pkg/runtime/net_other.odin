#+build !linux
package lava_runtime

import jsc "lava:pkg/jsc"

// node:net is Linux-first (net.odin). On other platforms the native bindings are empty,
// so js/internal/net.js surfaces a clear "unavailable" error when used, and the shared
// teardown hooks are no-ops. Restore alongside the Windows/macOS reactor work.

make_net_bindings :: proc(ctx: jsc.JSContextRef) -> jsc.JSObjectRef {
	return jsc.JSObjectMake(ctx, nil, nil)
}

net_shutdown_active :: proc(state: ^Runtime_State) {}

net_destroy_state :: proc(state: ^Runtime_State) {}
