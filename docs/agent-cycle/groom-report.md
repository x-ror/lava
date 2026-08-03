# Issue groom report (agent-cycle F3)

**Status:** proposal only — **do not mass-close without human confirmation**.

Generated from plan buckets in `docs/agent-cycle-plan.md`. Re-verify against
`gh issue list` and `git log` before acting; numbers drift.

## Proposed closes (shipped on master)

| Issue | Claim | Verify with |
| --- | --- | --- |
| #78 node:os | shipped | `git log --oneline --grep=os` / `pkg/runtime/os.odin` |
| #79 node:stream | shipped | stream module present |
| #80 node:net | shipped | `442a961` era |
| #81 node:http | shipped | http present |
| #183 #159 #91 | shipped | confirm PR links in issue |
| #107 #145 #243 #185 | close after re-verify | manual |

## Rewrite to residual (half-merged)

Issues 331, 266, 104, 105, 254/255 (dup), 35 — body still reads fully open; rewrite
Acceptance to remaining work only.

## Human-only (do not auto-queue)

| Issue | Why |
| --- | --- |
| #336 | bench-gate / thresholds — agent can "fix" a correct cap |
| #65 #261 #186 | research / weak resource / design |

## Queue as-is (bucket a — re-check before pilot)

337 (done in this PR if landed), 335, 332, 252, 250, 247, 245, 226, 193,
86, 85, 64, 66.

## Stale reference

`reference/node-compat.json` was generated against an old SHA and still lists
net/os/http/https/dns as missing. **Do not use as a groom map** until
regenerated. Marked in plan; regenerating is a separate task.

## Priority labels

Repo had no priority labels. Suggested: `P0` `P1` `P2` `human-only` `epic`
plus existing `area:*`. Apply during groom, not by the driver alone.
