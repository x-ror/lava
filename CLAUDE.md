# Lava — working agreement

Node-compatible JavaScript runtime: **JavaScriptCore** is the VM, **Odin** owns the
runtime (FFI, event loop, I/O transports, native stdlib). Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before any structural change.

Layering (never blur it):

| Layer                       | Path                          | Holds                                            |
| --------------------------- | ----------------------------- | ------------------------------------------------ |
| CLI                         | `cmd/lava`                    | argv → loop → `runtime.eval/run_file`            |
| Runtime orchestration       | `pkg/runtime`                 | globals, require, native primitives              |
| Embedded spec surface       | `pkg/runtime/js/internal/*.js`| `Buffer`, `fetch`, streams, `URL`, `http`…       |
| Engine FFI / private ABI    | `pkg/jsc`                     | JSC C API, string/view/host ABI, probes          |
| Event loop                  | `pkg/runtime/eventloop`       | phases, timers, io_uring/epoll, threadpool       |

---

## 1. How code is judged (ranked, in this order)

1. **Node interface conformance.** The observable surface — names, argument
   coercion order, defaults, thrown error `code`/`name`/`message`, event order,
   return types — matches Node 22+/24. Node is the oracle, not our reading of the
   docs. Deviation is allowed **only** when it buys measured speed or memory
   control, and then it must be: written down in the code comment, listed in the
   PR, and covered by a Lava-only test pinning the intended behavior.
2. **Speed and memory.** Fewer allocations, fewer copies, fewer FFI crossings,
   less memory per connection/request. A perf claim without a `make bench` number
   or a profile is not a perf claim.

Everything else (quality, docs, security, coverage) is a gate, not a ranking:
a PR that fails one of them does not merge regardless of how fast it is.

---

## 2. Reuse-first law (applies to every new native line)

Before writing new low-level code, prove nothing already implements it. Search in
this order and stop at the first real fit:

1. **In-repo** — `pkg/runtime/*.odin`, `pkg/jsc`, `pkg/runtime/eventloop`,
   `pkg/runtime/picohttpparser`. Duplicating our own helper is the most common
   defect in this codebase.
2. **Odin `core:`** — the SDK is large and already covers most of what a runtime
   needs (`core:net`, `core:crypto/*`, `core:encoding/*`, `core:sys/linux/uring`,
   `core:sys/posix`, `core:mem`, `core:sync`, `core:thread`, `core:simd`,
   `core:text/regex`, `core:container/*`, `core:time`, `core:strconv`). Index:
   [.claude/skills/odin-feature/reference/odin-sdk-map.md](.claude/skills/odin-feature/reference/odin-sdk-map.md).
3. **Odin `vendor:`** — vendored third-party bindings shipped with the SDK.
4. **C libraries already linked** — JavaScriptCore, OpenSSL, SQLite, libc/POSIX,
   `picohttpparser`. Extending an existing link costs nothing.
5. **A new C dependency** — allowed, but must justify: license, Linux packaging
   story, CI provisioning, binary-size impact, and why 1–4 do not work.
6. **Hand-rolled** — last resort. Requires a written reason in the file: measured
   perf, ABI mismatch, allocator control, or a Node semantic the SDK cannot express.

A rejection of an SDK candidate must cite evidence (`core:x/y.odin:NN` plus the
concrete problem: per-call allocation, wrong error taxonomy, blocking, missing
case) — never "probably doesn't fit". Precedents in-tree: DNS uses `core:net`'s
resolver instead of `getaddrinfo`; KDFs use `core:crypto/{pbkdf2,hmac,hkdf}`;
io_uring uses `core:sys/linux/uring`; HTTP parsing vendors `picohttpparser`
because no Odin equivalent matches its throughput.

Use the `odin-sdk-scout` agent for this search — it reads the real SDK source.

---

## 3. Commands

```sh
make check            # Odin type-check (incl. windows/darwin cross-target front-end)
make check-js         # vp fmt + lint + orphan-JS + primordials ratchet
make check-md         # markdownlint over the repo's docs (make fix-md auto-fixes)
make check-actions    # actionlint over .github/workflows
make build            # ./scripts/build.sh → bin/lava
make test             # Odin unit tests + oracle suites
make test-lava        # every oracle suite compared node-vs-Lava
make bench            # node-vs-Lava ratio table (report-only)
```

Full per-subsystem routing (which smoke/bench a given path requires) lives in
[.claude/skills/pr-gate/reference/gates.md](.claude/skills/pr-gate/reference/gates.md).
Never claim a change works without running the gates its paths map to.

**Linux-first.** darwin/windows native code is stubs; CI runs Linux only. But
`make check` still cross-checks both targets — a change that breaks the stub
front-end fails CI.

---

## 4. Odin conventions

- **Allocator discipline.** A struct that outlives the call captures the owning
  `Runtime_State.allocator` at creation and clones *and* frees through it. Do not
  rely on the ambient `context.allocator`: a `proc "c"` callback resets `context`
  to `runtime.default_context()`, so alloc-inside-callback / free-at-teardown
  mismatches. Guarded by `module_cache_alloc_test`, `dns_alloc_test`.
- **Temp arena** is freed at one choke point per tick / per require / per eval.
  Anything crossing a loop turn must not live in `context.temp_allocator`.
- **JSC lifetimes.** Every `JSValueProtect` has exactly one `Unprotect`, on fire
  **or** on cancel, never both. Every `JSStringCreate*` has a `JSStringRelease`.
  Never hold an unrooted `JSValueRef` across an allocation that can GC.
- **FFI ABI.** JSC C API `_Bool` returns must be declared `-> bool` (1 byte), not
  `b32` — the historic "predicates are unreliable" bug. Pinned by
  `cmd/lava/jsc_predicates_test.odin`.
- **Private-ABI probes** latch failure only on a probe/self-test mismatch, never
  on a transient runtime allocation failure, and never permanently demote a whole
  process because of one bad call.
- **Threads** touch only their own request payload — never the loop, never JSC.
  Completions come back through `post_async`; JS values are materialized only on
  the loop thread.
- **Conditional compilation** (`when ODIN_OS`) must keep every target *compiling
  and honest*: a stub returns a real "unsupported" error, it does not silently
  succeed.
- **Comments explain why**, not what. Match the density of the surrounding file —
  this codebase documents non-obvious decisions inline and expects the same.
- File-size policy: `pkg/runtime/buffer.odin` stays under ~1000 lines (split into
  `buffer_utf8.odin` / `buffer_simd.odin` / `buffer_host.odin`). Dedicated `*_host`
  wrappers exist only for **measured** hot natives; cold natives use the generic
  `host_native_create` path. The UTF-16→UTF-8 bridge belongs in `pkg/jsc`, not
  `environment.odin`.
- `make fmt` (`odin strip-semicolon`) before committing Odin.

## 5. Embedded JS conventions (`pkg/runtime/js/internal`)

- Route through `require('primordials')` — internal modules run alongside user
  code that can poison prototypes. `make check-primordials` is a **ratchet**: a
  hardened file (baseline 0) rejects any new pollutable call. `UPDATE=1` only to
  *lower* a baseline.
- The ratchet only counts Array/String prototype **method** calls. Three vector
  classes are invisible to it and are on you: (a) `f.apply(…)`/`f.call(…)` on an
  uncaptured function — use `ReflectApply`; (b) free globals and statics
  (`String`, `ArrayBuffer.isView`, `Buffer.from`, `Buffer.prototype.toString`) —
  capture at module-eval, which the loader runs before user code; (c) any object
  literal indexed by a caller-supplied key (label/scheme/header/encoding tables)
  — give it `__proto__: null`. Baseline 0 means "no counted call left", not
  "hardened".
- Pick the primordial by **arity**. `callerN` (`ArrayPrototypePush`) carries an
  `arguments` switch and belongs at cold call sites; per-element loops use the
  fixed-arity wrappers (`ArrayPrototypePush1`/`Push2`) or plain indexed writes
  into a preallocated null-prototype array. Getting this wrong cost 1.43x on the
  TextDecoder JS path.
- Nothing transient lands on `globalThis`; natives arrive as the factory's fourth
  argument.
- Errors are Node-shaped coded errors (`ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`)
  with Node's exact message template.
- Native byte ops stay behind the size threshold (`NATIVE_BYTEOP_MIN`) so small
  inputs skip FFI overhead.

## 6. Tests

Oracle-first: a behavior is correct when the same script produces byte-identical
output under `node` and under `bin/lava`. Add cases to
`tests/node-compat/cases`, `tests/runtime/*`, `tests/std/*`. Lava-only Odin tests
(`cmd/lava/*_test.odin`, `pkg/runtime/*_test.odin`) are for what Node cannot
oracle: allocator pairing, probe latching, pollution resistance, FFI ABI.

Widening `known-lava-gaps.txt` is a regression and needs an explicit reason.

## 7. PR contract

Title: `type(scope): imperative summary` (`feat(net):`, `perf(url):`,
`fix(http):`, `harden(url):`, `build(js):`, `refactor(runtime):`).

Every PR body states: what changed, the reuse verdict (§2), which gates were run
with results, Node-parity evidence (or the justified deviation), and bench numbers
if perf is claimed. Run `/pr-gate` before asking for review.

## 8. AI pipeline in this repo

- `/odin-feature <task>` — implement: reuse scout → design → implement → gates.
- `/pr-gate` — merge gate: mechanical gates + parallel specialist review + scorecard.
- Agents in [.claude/agents/](.claude/agents/) are specialists (`odin-sdk-scout`,
  `odin-implementer`, `regression-hunter`, `odin-safety-auditor`,
  `node-parity-auditor`, `perf-memory-auditor`, `security-auditor`,
  `test-coverage-auditor`, `code-quality-auditor`, `docs-auditor`).
