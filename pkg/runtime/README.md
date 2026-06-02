# Runtime

Runtime orchestration will live here: JSC context lifecycle, module loading,
standard library globals, timers, subprocesses, filesystem APIs, and test
runner hooks.

The event-loop core lives in `pkg/runtime/eventloop`. Its deterministic model
pins the scheduling contract before JavaScriptCore is wired into the runtime:
next-tick tasks, microtasks, timers, intervals, immediates, cancellation, and
run-until-idle behavior.

Linux now uses a native platform backend that tries `io_uring` first and falls
back to `epoll` when the kernel or sandbox does not allow a ring. Darwin and
Windows keep platform files for future `kqueue` and IOCP support.
