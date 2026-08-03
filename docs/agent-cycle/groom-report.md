# Issue groom report (agent-cycle F3)

**Status:** proposal only — **do not mass-close or bulk-edit issues without human confirmation**.

**Generated:** 2026-08-03 against `master` @ `79333fc` (post PR #340).  
**Open issues:** 61 (same count as plan).  
**Buckets:** plan (a–e) only — no new buckets invented.

Re-verify with `gh issue list` and `git log` before acting; this report is the
actionable proposal, not an automatic write to GitHub.

---

## Summary counts (re-verified)

| Action | Plan n | This pass | Delta |
| --- | --: | --: | --- |
| close as shipped | 7 | **12** | +#159 #183 #91 #107 #337; #145 → residual (HE only) |
| close after verify | 4 | **2** | #185 yes; #243 remeasure (do not close yet); #107 → shipped |
| rewrite to residual | 7 | **8** | +#145 HE; #254/#255 largely done — re-check |
| decompose (epic / multi) | 26 | **26** | list refined |
| mark human-only | 4 | **4** | unchanged |
| **queue as-is (bucket a)** | **13** | **12** | #337 out → close |

Arithmetic: 12 + 2 + 8 + 26 + 4 + 12 = **64** if 254/255 counted separate and
145 counted only in residual — see detailed tables (254/255 treated as **one**
dup pair in residual rewrite; 145 only residual). Canonical action sets below
partition the 61 numbers with no double-count.

**Partition of all 61 open numbers:**

| Set | Issues |
| --- | --- |
| Close shipped | 78, 79, 80, 81, 91, 107, 159, 183, 337 **(9)** |
| Close after verify | 185, 145? → **no**: 185 only; optionally 254/255 after re-probe **(1–3)** |
| Residual rewrite | 35, 104, 105, 145 (HE), 243 (perf residual), 266, 331, 254\|255 **(8)** |
| Human-only | 65, 186, 261, 336 **(4)** |
| Queue as-is | 64, 66, 85, 86, 193, 226, 245, 247, 250, 252, 332, 335 **(12)** |
| Decompose | 34, 37, 38, 39, 40, 82, 83, 84, 103, 112, 136, 179, 180, 190, 191, 192, 194, 195, 196, 214, 215, 216, 217, 242, 328, 334 **(26)** |

9+1+8+4+12+26 = 60; the 61st is **#243** in residual (already in residual 8) —
count residual as including 243 → if close-after is only 185: 9+1+8+4+12+26=60.
Missing one: **#254 and #255 are two numbers** counted as one pair in residual.
Correct: residual line items = 35,104,105,145,243,266,331,254,255 = **9** numbers.
9+1+9+4+12+26 = **61**. ✓

---

## 1. Proposed closes — shipped on master

Do **not** close until you confirm. Evidence is commit / path, not the stale
`reference/node-compat.json` (still lists these as missing).

| Issue | Title claim | Evidence | Suggested close comment |
| --- | --- | --- | --- |
| **#78** | implement node:os | `442a961` os: implement node:os (#229); `pkg/runtime/os.odin` + `js/internal/os.js` | Shipped on master; module present. |
| **#79** | implement node:stream | `f0d28f3` feat(stream): classic node:stream; `js/internal/stream.js` (~50k) | Shipped; further stream gaps → new issues. |
| **#80** | implement node:net | `6e85c65` feat(net): node:net TCP server; `net.odin` + `js/internal/net.js` | Shipped. |
| **#81** | implement node:http/https | `5243ecc` feat(http); `js/internal/http.js` + `https.js` (TLS server later PRs) | Shipped core; residual TLS/client gaps → separate issues if needed. |
| **#91** | sqlite bind/read coercion | `dd7b56b` fix(sqlite)…(#91)(#165); `4828be9` BigInt; `tests/std/sqlite/cases/05-coercion.js` documents #91 | Shipped; oracle on Node 24. |
| **#107** | buffer offset/value validation | `86a427a` fix(buffer)…(#107)(#223) | Shipped; closes concrete divergences in body. |
| **#159** | JSValueIs* b32 hazard | `9a93f21` fix(jsc)…(#159)(#228); `cmd/lava/jsc_predicates_test.odin`; darwin bindings use `-> bool` | Shipped root fix. |
| **#183** | POLL_REMOVE / poll cancel | `0a20f86` eventloop/io_uring: real poll cancellation via generation tokens (#183)(#198) | Shipped (generation tokens path). |
| **#337** | ALLOWED keyed by line number | `d08e0b4` / PR #340; `scripts/lib/global-replace-detect.mjs` `allowKey` = `file:binding`; tests pin no `:\d+$` keys | **Code fixed; issue still OPEN** — close with evidence. |

### Close after re-verify (manual probe first)

| Issue | Claim | Verify command / note |
| --- | --- | --- |
| **#185** | sqlite 05-coercion fails under Node 22.22 | CI is **Node 24** (`setup-vp` node-version 24); case re-baselined `aa66737` for Node 24. Run `node tests/std/sqlite/cases/05-coercion.js` on Node 24 — expect green → close. |
| **#254 / #255** (dup pair) | styleText default stream + FORCE_COLOR | Tree has `styleText` → `process.stdout`, `js/internal/tty.js` `getColorDepth` / FORCE_COLOR / NO_COLOR. **Re-probe issue Acceptance against Node 24**; if green, close both as shipped/dup. Else residual one checklist. |

**Do not auto-close #243.** Caps in `bench/thresholds.json` still allow ~6–9× node on buffer-to-hex/base64/utf8. Original 13–17× claim is obsolete, but the issue is not “done.” Rewrite residual (below).

**Do not auto-close #145.** Address-list / multi-address fallback shipped in `967c193` (#145 in message); Happy Eyeballs still open as residual.

---

## 2. Rewrite to residual (half-merged / body still reads fully open)

For each: keep open, replace body Acceptance with **remaining** work only, add
`<!-- lava-task -->`. Drafts:

### #331 — util.inspect caps only

Control-character escaping **shipped** (`util.js` strEscape / `#330` era). Residual:

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: false
attempts: 0
review-tier: L1
area: util
-->
```

**Acceptance (residual only):**

- [ ] `util.inspect` honors `maxArrayLength` / `maxStringLength` (Node defaults) — contract comment + node probe
- [ ] oracle case: long array/string truncated like node; control-char path remains green
- [ ] routed L0/L1 green (`util.js` paths)

### #266 — path.matchesGlob fidelity

Implementation exists (`path.js` matchesGlob). Residual = fidelity gaps in issue body (no-magic case-sensitivity, leading/trailing dot, POSIX classes, `!(|)` negation). Keep open; rewrite Acceptance to a checklist of **failing** probes only (derive from node-vs-lava).

### #104 — util/console residual

Shipped since filing: `promisify` / `callbackify` / `inherits` / `types`. Residual candidates:

- `console.Console` constructor (comment in `console.js`: not yet provided)
- any remaining inspect/format/%d/%i / getter-invocation gaps — **must re-probe** before coding

### #105 — events.once({signal})

`once(emitter, name)` is 2-arg only (`events.js`); `on(..., {signal})` exists. Residual:

- [ ] `events.once(emitter, name, { signal })` aborts like Node
- [ ] confirm `defaultMaxListeners` is live (setter path present — may already be OK)

### #145 — Happy Eyeballs only

```html
<!-- lava-task
priority: P2
blocked-by: []
blocks-surface: false
attempts: 0
review-tier: L1
area: fetch
-->
```

**Acceptance:**

- [ ] Address-list connect fallback already on master — document in issue, do not reimplement
- [ ] Happy Eyeballs (RFC 8305 stagger IPv6/IPv4) **or** explicit “wontfix / later epic” decision
- [ ] design-only first (`odin-feature --design-only`) before implement

### #243 — buffer toString perf residual

Rewrite title/body to current ratios (remeasure `make bench` buffer-to-hex/base64/utf8). Not queue-as-is until a single measurable slice is named.

### #35 — CI toolchain residual

Partially done: `actions/checkout@v7`, Node 24 via `setup-vp`, `setup-odin@v2`. Residual:

- pin **specific** Odin release (not floating default) if still floating
- macOS/Windows CI still intentionally disabled — document or drop from Acceptance
- document toolchain in repo if not already

### #254 / #255

Treat as **dup**: keep one, close the other after re-verify (see close-after-verify).

---

## 3. Human-only (do not auto-queue)

| Issue | Why |
| --- | --- |
| **#336** | bench-gate / `thresholds.json` — agent can “fix” a correct cap; plan F6/F7 human-only |
| **#65** | top-level await in ESM — large loader/ESM design |
| **#261** | util.aborted weak resource / GC lifetime — hard to oracle; needs-human-decision |
| **#186** | Buffer huge alloc JSC abort vs RangeError — engine/policy tradeoff |

Suggested labels: `human-only` (+ existing area).

---

## 4. Queue as-is (bucket a) — pilot order

Prefer plan F7 order after closes: **(#337 closed) → human #336 → #247** then others.

| # | Title (short) | Code status (2026-08-03) | Priority seed |
| --- | --- | --- | --- |
| **247** | process/console export intrinsic not lazy global | Still `module.exports = process` / `console` at factory time; same class as #333 | P1 |
| **335** | Coded errors omit `[CODE]` in toString/stack | `err.code` set; no Node `name`/`toString` bracket form | P1 |
| **85** | Timeout ref/unref | Loop has `timer_ref`/`timer_unref`; setTimeout returns **number** only | P1 |
| **86** | btoa/atob + process.hrtime | Buffer has atob/btoa helpers not globals; no `process.hrtime` | P1 |
| **66** | require.resolve / main / cache | Undefined on require object | P1 |
| **64** | dynamic import() | Left to JSC; fails with import error | P1 |
| **252** | parseArgs allowNegative | Explicit NOTE: not implemented | P2 |
| **250** | promisify/callbackify/deprecate fidelity | Checklist in issue body still accurate | P2 |
| **245** | stdlib edge-cases (qs/string_decoder/types) | Multi-file but finite | P2 |
| **226** | fetch header cap vs --max-http-header-size | `FETCH_MAX_HEADER_BYTES :: 256*1024` hardcoded | P2 |
| **193** | crypto argon2/argon2Sync | `notImplemented`; `core:crypto/argon2id` available | P2 |
| **332** | perf(fs) encoded reads | Perf slice; design-only first | P2 |
| ~~337~~ | ~~global-replace ALLOWED keys~~ | **DONE** — close, do not queue | — |

### Draft `lava-task` + Acceptance (queue-as-is)

Apply only after human confirms (bulk-edit of issue bodies is external).

#### #247

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: true
attempts: 0
review-tier: L1
area: loader,process,console
-->
```

**Acceptance:**

- [ ] Contract: `require('node:process')` / `require('node:console')` always return the init-time intrinsic (node probe after `globalThis.process = {}` before require)
- [ ] Red oracle case under `tests/node-compat/cases/` — fails before fix, green after under node-vs-lava
- [ ] Capture via eager load and/or `natives` 4th factory arg — not a live global read in a lazy factory (`CLAUDE.md` §5 / #333 class)
- [ ] Mutation entry if §6 requires; L0+L1 for loader/process paths

#### #335

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: true
attempts: 0
review-tier: L1
area: errors
-->
```

**Acceptance:**

- [ ] Node probe: coded TypeError `toString()` / first stack line includes `[ERR_*]` while `name === 'TypeError'`
- [ ] Shared construction path (JS and/or `errors.odin`) — not six hand-rolled formatters
- [ ] Oracle case covering JS-layer + native-thrown coded error
- [ ] L0+L1; mutation if shared error helper is user-visible

#### #85

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: true
attempts: 0
review-tier: L1
area: timers,eventloop
-->
```

**Acceptance:**

- [ ] `setTimeout`/`setInterval`/`setImmediate` return handle with `.ref()`/`.unref()` (node probe)
- [ ] Unreffed-only interval does not keep process alive; ref'd does
- [ ] `clearTimeout`/`clearInterval` accept handle and numeric id
- [ ] Wire existing `eventloop.timer_ref` / `timer_unref` — do not reimplement loop semantics
- [ ] Oracle case + L0+L1; design-only if Timeout object shape is non-trivial

#### #86

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: false
attempts: 0
review-tier: L1
area: globals,process
-->
```

**Acceptance:**

- [ ] Globals `btoa`/`atob` present; round-trip oracle (reuse Buffer base64)
- [ ] `process.hrtime()` → `[s, ns]`; `process.hrtime.bigint()` monotonic BigInt
- [ ] Back hrtime with existing monotonic clock (`performance.now` path)
- [ ] node-compat case + L0+L1

#### #66

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: true
attempts: 0
review-tier: L1
area: loader,require
-->
```

**Acceptance:**

- [ ] `require.resolve(spec)` absolute path (reuse `resolve_module_path`)
- [ ] `require.main` entry module; `require.cache` registry (may stage resolve first)
- [ ] Oracle: resolve idempotent + main/cache shape vs node
- [ ] design-only first; L0+L1

#### #64

```html
<!-- lava-task
priority: P1
blocked-by: []
blocks-surface: true
attempts: 0
review-tier: L1
area: loader,esm
-->
```

**Acceptance:**

- [ ] `await import('./x.mjs')` resolves via Lava loader (not bare JSC)
- [ ] Named + default export readable; relative path works
- [ ] Oracle case; design-only first (`esm.js` / native bridge)
- [ ] L0+L1; no primordials baseline raise

#### #252

```html
<!-- lava-task
priority: P2
blocked-by: []
blocks-surface: false
attempts: 0
review-tier: L1
area: util
-->
```

**Acceptance:**

- [ ] `allowNegative: true` → `--no-foo` boolean negation (node probe)
- [ ] default-args under eval-mode argv per issue body
- [ ] Oracle + L0+L1 (`parse_args.js`)

#### #250

```html
<!-- lava-task
priority: P2
blocked-by: []
blocks-surface: false
attempts: 0
review-tier: L1
area: util
-->
```

**Acceptance:** (from issue checklist — each independently oracled)

- [ ] promisify custom idempotency (`promisify(promisify(custom))`)
- [ ] callbackify `length === original.length + 1`; falsy rejection `ERR_FALSY_VALUE_REJECTION`
- [ ] deprecate checks `noDeprecation` at call time; preserves prototype for constructors
- [ ] Oracle case(s) + L0+L1

#### #245 / #226 / #193 / #332

Shorter seeds — expand Acceptance when picking up:

| # | Acceptance spine |
| --- | --- |
| 245 | One oracle case per surface (querystring / string_decoder / util.types spoofing); no drive-by refactors |
| 226 | Honor Node `--max-http-header-size` (or document deliberate hardcode + test pin); contract on `fetch.odin` |
| 193 | `crypto.argon2` / `argon2Sync` via `core:crypto/argon2id`; node-compat + reuse scout first |
| 332 | design-only + `make bench` number; decode-in-native path; no silent quality drop |

---

## 5. Decompose (bucket b — 26)

No reachable single “done”. Do **not** queue whole issues. Start children from:

| Parent | Suggested first child themes |
| --- | --- |
| **#334** | fs signal ignored; flag ignored; URL/fd path; PASSTHROUGH drift — **one PR per class** |
| **#328** | process.stdout/stderr holes; tty columns/rows — split tty vs stdio |
| **#103** | assert deepStrictEqual — one failure mode per issue |
| **#84** | fs async surface — promises vs watch vs chmod as separate |
| **#242** | fs.writeFile normalization — DataView / SAB / encoding / flag |
| **#82** | node:zlib epic |
| **#83** | node:dns epic (tier-1 exists; #179/#180 are children) |
| **#179 #180** | dns tier-2 / lookup parity — keep as child tasks when groomed |
| **#190–196 #215** | crypto epic tree — argon2 is #193 (queue); rest stay epic |
| **#214** | web streams remaining |
| **#34** | Buffer broaden epic |
| **#37 #38 #39** | package install / bundler / release — out of runtime cycle |
| **#40 #112 #136 #216 #217** | trackers / indices — not implementable tasks |

Driver must skip issues without `<!-- lava-task -->` + finite Acceptance.

---

## 6. Stale reference

`reference/node-compat.json` `generated_against.lava_rev` = **`3de9128`**, still marks
os/net/http/https/dns/stream/querystring/string_decoder as **missing** while modules
exist on master.

- **Header marked STALE** in this groom pass (see file).
- **Do not use as groom map** until regenerated against current `master`.
- Regenerating is a **separate** task (not auto-queue).

Unlabeled open issues (14): `35,37,38,39,226,261,266,328,331,332,334,335,336,337`
— suggest labels: `P0`/`P1`/`P2`, `human-only`, `epic`, `area:*`.

---

## 7. Human confirmation checklist

Reply with which actions to take (copy/paste):

```text
[ ] Close shipped: #78 #79 #80 #81 #91 #107 #159 #183 #337
[ ] Close after Node-24 probe: #185
[ ] Close or residual after probe: #254 #255 (dup)
[ ] Apply residual rewrites (bodies): #35 #104 #105 #145 #243 #266 #331
[ ] Label human-only: #65 #186 #261 #336
[ ] Apply lava-task drafts to queue-as-is (12 issues)
[ ] Create priority labels (P0/P1/P2/human-only/epic) if missing
[ ] Regenerate reference/node-compat.json (separate task)
```

**Until you confirm, no `gh issue close` and no bulk body edits.**

---

## 8. Next after confirm

1. Apply approved closes with evidence comments.
2. Patch approved issue bodies with `lava-task` + Acceptance.
3. F7 pilot: **#247** (after #337 closed; #336 stays human).
4. Manual cycle: worktree + `/odin-feature --design-only` + route-gates L0/L1 — not F6 expansion.
