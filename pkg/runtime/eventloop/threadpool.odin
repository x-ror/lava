package eventloop

import "core:mem"
import "core:sync"
import "core:thread"

// Generic worker pool. Any blocking or CPU-bound operation (file I/O, a crypto KDF)
// runs OFF the loop thread on a fixed set of workers, then its completion is handed
// back to the loop thread through the same post_async path the async DNS resolver
// uses. This generalizes fetch_dns_pool: instead of one DNS-specific job type, a
// caller supplies a `work` proc (run off-loop) and a `done` proc (run on the loop).
//
// The pool is OWNED BY THE LOOP (Loop.pool), not a process global: each loop has its
// own workers, and destroy() tears down only that loop's pool. (A process-global pool
// would race across loops — notably the parallel test runner, where one loop's
// destroy would join another loop's still-running workers.)
//
// Memory: the pool's containers and Pool_Job allocations all use loop.allocator (the
// same ownership contract the loop's queues follow — see loop.odin init); the loop
// thread is the only one that allocates or frees them (workers only pop and post).
//
// Lifetime / safety mirrors the DNS pool:
//   - Workers are lazily started on the first submit, so a loop that never offloads
//     work spawns no threads.
//   - pool_submit does async_begin(loop) so the loop stays alive and parked in poll
//     until the completion is posted; the matching decrement happens in drain_async
//     when the completion runs.
//   - A worker touches ONLY its job's user_data (never the loop or the JS engine);
//     the single cross-thread handoff is the post_async at the end. The lock/unlock
//     inside post_async publishes whatever the worker wrote into user_data.
//   - At teardown destroy() calls pool_shutdown(loop), which stops and joins every
//     worker BEFORE the loop's async_queue is touched, so no worker can post into a
//     destroyed loop.

// THREADPOOL_SIZE mirrors libuv's default UV_THREADPOOL_SIZE.
THREADPOOL_SIZE :: 4

// Pool_Work runs on a worker thread, off the loop. It must touch only its own
// user_data — no loop calls, no JS engine access — since it runs concurrently with
// the loop thread. Its result is carried back through user_data.
Pool_Work :: proc(user_data: rawptr)

// Pool_Done runs on the loop thread after the work finishes (delivered through
// post_async), so it may safely touch the loop and the JS engine.
Pool_Done :: proc(loop: ^Loop, user_data: rawptr)

// Pool_Dispose releases a job's user_data when its `done` will NOT run — i.e. the job
// was dropped at loop teardown (still queued, or its completion posted but discarded
// with the async_queue). Exactly one of {done, dispose} runs per job, so a caller can
// release a protected JS callback / buffer / path here without separately tracking
// in-flight requests. Runs on the loop thread, inside pool_shutdown. Optional.
Pool_Dispose :: proc(user_data: rawptr)

// Pool_Job pairs a unit of off-loop work with its on-loop completion. Allocated by
// pool_submit and freed by its completion (pool_complete) — or by pool_shutdown for a
// job whose completion is dropped at teardown. user_data is owned by the caller, not
// the pool; the pool only ever frees the Pool_Job wrapper (and invokes `dispose` so
// the caller can free user_data on the dropped path).
Pool_Job :: struct {
	work:      Pool_Work,
	done:      Pool_Done,
	dispose:   Pool_Dispose,
	user_data: rawptr,
	loop:      ^Loop,
}

// Thread_Pool is embedded in Loop. Its containers use loop.allocator; nothing is
// allocated and no thread is started until the first pool_submit.
//
// `pending` is a growable circular buffer (ring): jobs are enqueued at the tail and
// dequeued from `pending_head`, both O(1) under the mutex — no front-shift, so a large
// fs/crypto backlog does not turn dequeue into O(n) (and does not hold the mutex while
// memmoving). The backing grows by doubling and is bounded by the peak queue depth
// (slots are reused via wraparound), not by the total number of jobs ever submitted.
Thread_Pool :: struct {
	mutex:         sync.Mutex,
	wake:          sync.Cond, // workers sleep here until a job arrives or stop is requested
	pending:       []^Pool_Job, // ring backing (cap = len(pending)); mutex-guarded
	pending_head:  int, // index of the next job to dequeue
	pending_count: int, // number of live jobs in the ring
	threads:       [dynamic]^thread.Thread,
	outstanding:   [dynamic]^Pool_Job, // every live job (loop-thread-only; for teardown dispose/free)
	started:       bool,
	stopping:      bool,
}

// pool_init binds the pool's dynamic containers to the loop allocator at zero
// capacity. Called once from the loop's init(); the ring backing stays nil and no
// thread is started until the first pool_submit.
pool_init :: proc(pool: ^Thread_Pool, allocator: mem.Allocator) {
	pool.threads = make([dynamic]^thread.Thread, allocator)
	pool.outstanding = make([dynamic]^Pool_Job, allocator)
}

// pool_destroy frees the pool's container backings. The workers must already be
// joined (pool_shutdown) — destroy() calls them in that order.
pool_destroy :: proc(pool: ^Thread_Pool, allocator: mem.Allocator) {
	delete(pool.threads)
	delete(pool.outstanding)
	if pool.pending != nil do delete(pool.pending, allocator)
}

// pool_ring_push appends a job at the ring's tail, growing (doubling) when full.
// Mutex-held, loop thread. (Package-visible — not file-private — so the ring's
// FIFO/grow/wrap behavior can be unit-tested directly without spinning up workers.)
pool_ring_push :: proc(pool: ^Thread_Pool, job: ^Pool_Job, allocator: mem.Allocator) {
	if pool.pending_count == len(pool.pending) {
		new_cap := max(8, len(pool.pending) * 2)
		ns := make([]^Pool_Job, new_cap, allocator)
		// Copy the live entries into the front of the new backing, unwrapping the ring.
		for i in 0 ..< pool.pending_count {
			ns[i] = pool.pending[(pool.pending_head + i) % len(pool.pending)]
		}
		if pool.pending != nil do delete(pool.pending, allocator)
		pool.pending = ns
		pool.pending_head = 0
	}
	tail := (pool.pending_head + pool.pending_count) % len(pool.pending)
	pool.pending[tail] = job
	pool.pending_count += 1
}

// pool_ring_pop removes and returns the head job. Caller guarantees the ring is
// non-empty. Mutex-held, worker thread. (Package-visible for the ring unit test.)
pool_ring_pop :: proc(pool: ^Thread_Pool) -> ^Pool_Job {
	job := pool.pending[pool.pending_head]
	pool.pending_head = (pool.pending_head + 1) % len(pool.pending)
	pool.pending_count -= 1
	return job
}

// pool_submit hands a unit of work to the loop's pool. `work` runs off-loop; `done`
// runs on the loop thread once it finishes; `dispose` (optional) releases user_data if
// the job is dropped at teardown before `done` runs. Returns false only if no worker
// thread could be started (or on a nil loop/work), in which case nothing is scheduled.
// Loop-thread only.
pool_submit :: proc(
	loop: ^Loop,
	work: Pool_Work,
	done: Pool_Done,
	user_data: rawptr = nil,
	dispose: Pool_Dispose = nil,
) -> bool {
	if loop == nil || work == nil do return false
	pool := &loop.pool

	// Keep the loop alive (and blocking in poll) until the completion is posted.
	// Undone if the pool can't be started, so the loop is not pinned forever.
	async_begin(loop)
	if !pool_ensure_started(loop) {
		async_cancel(loop)
		return false
	}

	job := new(Pool_Job, loop.allocator)
	job.work = work
	job.done = done
	job.dispose = dispose
	job.user_data = user_data
	job.loop = loop

	// outstanding is mutated only on the loop thread (submit, complete, shutdown), so
	// it needs no lock; the pending ring is shared with the workers.
	append(&pool.outstanding, job)
	sync.lock(&pool.mutex)
	pool_ring_push(pool, job, loop.allocator)
	sync.cond_signal(&pool.wake)
	sync.unlock(&pool.mutex)
	return true
}

@(private = "file")
pool_ensure_started :: proc(loop: ^Loop) -> bool {
	pool := &loop.pool
	if pool.started do return true
	pool.stopping = false
	// Workers receive the loop pointer and reach the pool through loop.pool; the loop
	// outlives them (destroy joins every worker before the loop is freed).
	for _ in 0 ..< THREADPOOL_SIZE {
		th := thread.create_and_start_with_data(loop, pool_worker, nil, .Normal, false)
		if th != nil do append(&pool.threads, th)
	}
	// As long as one worker started, the pool can make progress.
	if len(pool.threads) == 0 do return false
	pool.started = true
	return true
}

@(private = "file")
pool_worker :: proc(data: rawptr) {
	loop := cast(^Loop)data
	pool := &loop.pool
	for {
		sync.lock(&pool.mutex)
		for pool.pending_count == 0 && !pool.stopping {
			sync.cond_wait(&pool.wake, &pool.mutex)
		}
		if pool.stopping && pool.pending_count == 0 {
			sync.unlock(&pool.mutex)
			return
		}
		job := pool_ring_pop(pool) // FIFO from the ring head, O(1)
		sync.unlock(&pool.mutex)

		if job.work != nil do job.work(job.user_data)
		// Release any per-job scratch the work left on this worker's temp arena.
		free_all(context.temp_allocator)
		// Hand back to the loop thread. After this the worker must not touch the job —
		// the completion (or teardown) owns it now.
		post_async(job.loop, pool_complete, job)
	}
}

// pool_complete runs on the loop thread once a job's work finishes: it frees the job
// wrapper, then invokes the caller's `done` with (loop, user_data). The job is
// released before `done` runs so a `done` that submits more work cannot observe a
// half-freed wrapper. `dispose` is NOT called on this path — `done` owns user_data on
// success. The async_begin from submit is balanced by drain_async's decrement around
// this call.
@(private = "file")
pool_complete :: proc(loop: ^Loop, user_data: rawptr) {
	job := cast(^Pool_Job)user_data
	done := job.done
	ud := job.user_data
	pool_release_job(loop, job)
	if done != nil do done(loop, ud)
}

@(private = "file")
pool_release_job :: proc(loop: ^Loop, job: ^Pool_Job) {
	pool := &loop.pool
	for i in 0 ..< len(pool.outstanding) {
		if pool.outstanding[i] == job {
			unordered_remove(&pool.outstanding, i)
			break
		}
	}
	free(job, loop.allocator)
}

// pool_shutdown stops the loop's pool and joins its workers, so no worker can post
// into a loop about to be destroyed.
//
// CONTRACT: destroy-only. This is NOT a quiesce/restart primitive — it does not
// balance the per-job async_begin counts (active_async is left as-is) and does not
// remove the pool completions already posted to async_queue (which, once their jobs
// are freed here, dangle). That is safe ONLY because destroy() calls this and then
// immediately tears the whole loop down (async_queue included, with those completion
// callbacks never invoked). A future "pause the pool but keep the loop running" use
// would need to also decrement active_async per dropped job and cancel/skip the
// queued completions. Don't call this outside destroy().
//
// Loop-thread only; idempotent (a no-op once stopped, or when never started).
// Queued-but-unstarted jobs are dropped under the
// lock before the workers are woken, so the join blocks only on work already in
// flight — at most THREADPOOL_SIZE units, not the whole backlog. After the join every
// still-outstanding job has its `dispose` invoked (so the caller can release
// user_data) and the wrapper freed: these are the jobs whose `done` will never run —
// the dropped-queue ones, plus any whose completion was posted but is discarded when
// the loop's async_queue is torn down (that task's callback is never invoked, so the
// freed pointer is not dereferenced).
pool_shutdown :: proc(loop: ^Loop) {
	pool := &loop.pool
	if !pool.started do return
	sync.lock(&pool.mutex)
	pool.stopping = true
	// Drop the queued backlog (the jobs stay in `outstanding`, freed/disposed below).
	pool.pending_count = 0
	pool.pending_head = 0
	sync.cond_broadcast(&pool.wake)
	sync.unlock(&pool.mutex)
	for th in pool.threads {
		thread.join(th)
		thread.destroy(th)
	}
	clear(&pool.threads)
	for job in pool.outstanding {
		if job.dispose != nil do job.dispose(job.user_data)
		free(job, loop.allocator)
	}
	clear(&pool.outstanding)
	pool.started = false
}
