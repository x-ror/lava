/**
 * DAG extraction from the tracker.
 *
 * The ordering these functions recover is the one a human wrote in #217. If the
 * parse drifts, the autonomous queue silently reorders itself — features ahead
 * of correctness bugs, epics ahead of their children — and nothing else in the
 * system would notice, because every downstream stage happily processes whatever
 * it is handed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskList,
  parseTierIndex,
  parseProseOrdering,
  buildDag,
  readyQueue,
  explain,
  UNTIERED,
} from './dag.mjs';

const QUEUE = 217;

/** Shape of the real #217 body, trimmed to what the parser must handle. */
const INDEX_BODY = `# Lava — master priority queue (index)

| Tracker | Scope |
|---|---|
| #40 | v1.0.0 feature ladder |

## How this list stays live

1. Correctness before features.

## Ordered queue

### Tier 1 — cleanup *(done)*
- [x] Close #184 (Web Streams shipped)

### Tier 2 — parity/correctness bugs
- [ ] #91 — sqlite: bind/read coercion divergences
- [x] #213 — buffer: Buffer.poolSize divergence
- [ ] #348 — process.exit kills sibling workers

### Tier 3 — platform hardening
- [ ] #101 — Windows watch_fd stub *(do before #80/#81 land socket transport)*
- [ ] #111 — O(n²) timer bookkeeping → heap
`;

function issue(number, extra = {}) {
  return { number, title: `#${number}`, body: '', labels: [], ...extra };
}

const OPEN = [
  issue(QUEUE, { body: INDEX_BODY }),
  issue(91),
  issue(213),
  issue(348),
  issue(101),
  issue(111),
  issue(80),
  issue(81),
  issue(500), // never mentioned by the index
];

test('task-list items are read with their checkbox state', () => {
  const items = parseTaskList('- [ ] #7 open\n- [x] #8 done\n* [X] #9 upper\nnot a task #10');
  assert.deepEqual(
    items.map((i) => [i.number, i.done]),
    [
      [7, false],
      [8, true],
      [9, true],
    ],
  );
});

test('tier headings assign a tier to the items beneath them', () => {
  const tiers = parseTierIndex(INDEX_BODY);
  assert.equal(tiers.get(91).tier, 2);
  assert.equal(tiers.get(348).tier, 2);
  assert.equal(tiers.get(101).tier, 3);
  assert.equal(tiers.get(111).tier, 3);
});

test('a checked item is recorded as done even while its issue is open', () => {
  const tiers = parseTierIndex(INDEX_BODY);
  assert.equal(tiers.get(213).done, true);
  assert.equal(tiers.get(91).done, false);
});

test('a checklist above the first tier heading is not part of the queue', () => {
  // #217 opens with trackers and house rules before "## Ordered queue". A
  // checkbox up there is someone's notes, and reading it as a queue item would
  // let it mark real work done. Only items under a `### Tier N` count.
  const body = ['- [x] #91 — a note, not the queue', '### Tier 2 — real', '- [ ] #348'].join('\n');
  const tiers = parseTierIndex(body);
  assert.equal(tiers.has(91), false, 'a pre-tier item leaked into the queue');
  assert.equal(tiers.get(348).tier, 2);
});

test('a table row mentioning #40 is not a queue item', () => {
  // `| #40 | …` is a tracker table, not a task list. Reading it as one would
  // inject an untiered epic into the middle of the queue.
  assert.equal(parseTierIndex(INDEX_BODY).has(40), false);
});

test('prose ordering turns "do before" into real edges', () => {
  const edges = parseProseOrdering(parseTaskList(INDEX_BODY));
  // "#101 … do before #80/#81" means 80 and 81 wait for 101.
  assert.deepEqual(edges.sort(), [
    [80, 101],
    [81, 101],
  ]);
});

test('an epic is blocked by its own open children', () => {
  const issues = [
    issue(QUEUE, { body: INDEX_BODY }),
    issue(112, { body: '- [ ] #91\n- [ ] #348\n' }),
    issue(91),
    issue(348),
  ];
  const dag = buildDag(issues, { queueIssue: QUEUE });
  assert.deepEqual(dag.blockers(112), [91, 348]);
  assert.deepEqual(dag.blockers(91), []);
});

test('a task-list edge to a closed issue is a satisfied dependency, not a block', () => {
  // #999 is absent from the open set, so it has landed.
  const issues = [issue(QUEUE, { body: INDEX_BODY }), issue(112, { body: '- [ ] #999\n' })];
  const dag = buildDag(issues, { queueIssue: QUEUE });
  assert.deepEqual(dag.blockers(112), []);
});

test('a lava-task blocked-by naming a closed issue does not block either', () => {
  // Separate path from the task list: this one reaches the edge builder without
  // passing the task-list filter, so it is what actually pins the guard there.
  // The first version of this suite tested only the list path and the guard
  // could be deleted with every test still green.
  const issues = [
    issue(QUEUE, { body: INDEX_BODY }),
    issue(60, { body: '<!-- lava-task\nblocked-by: [999, 91]\n-->' }),
    issue(91),
  ];
  assert.deepEqual(buildDag(issues, { queueIssue: QUEUE }).blockers(60), [91]);
});

test('prose ordering naming a closed issue does not block either', () => {
  const body = '## Ordered queue\n\n### Tier 2 — x\n- [ ] #999 — landed *(do before #91)*\n';
  const issues = [issue(QUEUE, { body }), issue(91)];
  assert.deepEqual(buildDag(issues, { queueIssue: QUEUE }).blockers(91), []);
});

test('a checked child does not block its epic', () => {
  const issues = [
    issue(QUEUE, { body: INDEX_BODY }),
    issue(112, { body: '- [x] #91\n' }),
    issue(91),
  ];
  assert.deepEqual(buildDag(issues, { queueIssue: QUEUE }).blockers(112), []);
});

test('a self-referencing task list does not deadlock the queue', () => {
  const issues = [issue(QUEUE, { body: INDEX_BODY }), issue(50, { body: '- [ ] #50\n' })];
  assert.deepEqual(buildDag(issues, { queueIssue: QUEUE }).blockers(50), []);
});

test('an explicit lava-task blocked-by is still honoured', () => {
  const issues = [
    issue(QUEUE, { body: INDEX_BODY }),
    issue(60, { body: '<!-- lava-task\nblocked-by: [91, 348]\n-->' }),
    issue(91),
    issue(348),
  ];
  assert.deepEqual(buildDag(issues, { queueIssue: QUEUE }).blockers(60), [91, 348]);
});

test('the queue is ordered by tier, then by number', () => {
  const q = readyQueue(OPEN, { queueIssue: QUEUE }).map((i) => i.number);
  // 91 and 348 are tier 2; 111 is tier 3; 500 has no tier and sorts last.
  // 80 and 81 are blocked by 101, so they are absent entirely.
  assert.deepEqual(q, [91, 348, 101, 111, 500]);
});

test('the index issue is never queued as work', () => {
  assert.equal(
    readyQueue(OPEN, { queueIssue: QUEUE }).some((i) => i.number === QUEUE),
    false,
  );
});

test('an item checked off in the index is not queued', () => {
  assert.equal(
    readyQueue(OPEN, { queueIssue: QUEUE }).some((i) => i.number === 213),
    false,
  );
});

test('readiness is a separate decision from ordering', () => {
  // Ordering is derived from the tracker; permission to act is not. Without the
  // gate every open issue would be drainable the moment this code shipped.
  const gated = readyQueue(OPEN, {
    queueIssue: QUEUE,
    isReady: (i) => i.number === 111,
  });
  assert.deepEqual(
    gated.map((i) => i.number),
    [111],
  );
});

test('an untiered issue sorts after every tiered one', () => {
  const dag = buildDag(OPEN, { queueIssue: QUEUE });
  assert.equal(dag.tierOf(500), UNTIERED);
  assert.ok(dag.tierOf(500) > dag.tierOf(111));
});

test('explain says why an issue is held back', () => {
  const issues = [
    issue(QUEUE, { body: INDEX_BODY }),
    issue(112, { body: '- [ ] #91\n' }),
    issue(91),
  ];
  const dag = buildDag(issues, { queueIssue: QUEUE });
  assert.deepEqual(explain(dag, issue(112)).blockedBy, [91]);
  assert.deepEqual(explain(dag, issue(91)).epics, [112]);
});

test('a truncated issue fetch is refused, not silently drained', async () => {
  // The nastiest failure this design can have: buildDag reads an edge pointing
  // outside the open set as a satisfied dependency. A page that dropped issues
  // therefore does not lose work quietly — it UNBLOCKS everything waiting on
  // what it dropped, and the drain starts on prerequisites that never landed.
  const { assertNotTruncated } = await import('./github.mjs');
  assert.throws(() => assertNotTruncated(new Array(100), 100), /fetch limit/);
  assert.doesNotThrow(() => assertNotTruncated(new Array(99), 100));
});

test('a missing index degrades to number order rather than throwing', () => {
  // A fork without #217, or a fetch that failed: the queue must still work.
  const q = readyQueue([issue(9), issue(3)], { queueIssue: 12345 });
  assert.deepEqual(
    q.map((i) => i.number),
    [3, 9],
  );
});
