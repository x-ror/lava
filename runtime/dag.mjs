/**
 * Task DAG, derived from the issue tracker rather than stored beside it.
 *
 * The graph already exists in git: issue #217 is a hand-maintained priority
 * queue whose `### Tier N` headings carry the ordering and whose `- [ ] #N`
 * items carry membership, and every epic repeats the same task-list form for its
 * children. Writing a second copy into issue bodies (`<!-- lava-task -->`) or
 * into a backlog file would be the same data in two places, disagreeing within a
 * week — planner.md rule 1 says as much ("never invent .lava/backlog.yaml").
 *
 * So nothing here is authored. Tier, membership and blocking are read out of the
 * markdown that a human already maintains for their own use. What is NOT derived
 * is permission to act: that stays an explicit `agent-ready` label, because
 * ordering is a statement about the work and readiness is a decision about the
 * agent.
 */

/** Issue holding the ordered queue. Override for a fork with its own index. */
export const MASTER_QUEUE_ISSUE = Number(process.env.AGENT_QUEUE_ISSUE || 217);

/** Issues without a tier sort after every tiered one, in number order. */
export const UNTIERED = 99;

const TASK_ITEM = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*#(\d+)(.*)$/;
const TIER_HEADING = /^#{2,4}[ \t]+Tier[ \t]+(\d+)/i;

/**
 * Task-list items in one issue body.
 *
 * @param {string} body
 * @returns {{ number: number, done: boolean, rest: string }[]}
 */
export function parseTaskList(body) {
  const out = [];
  if (!body) return out;
  for (const line of body.split('\n')) {
    const m = line.match(TASK_ITEM);
    if (m) out.push({ number: Number(m[2]), done: m[1] !== ' ', rest: m[3] || '' });
  }
  return out;
}

/**
 * Tier assignment from the master queue body.
 *
 * @param {string} body
 * @returns {Map<number, { tier: number, done: boolean }>}
 */
export function parseTierIndex(body) {
  const tiers = new Map();
  if (!body) return tiers;
  let tier = null;
  for (const line of body.split('\n')) {
    const h = line.match(TIER_HEADING);
    if (h) {
      tier = Number(h[1]);
      continue;
    }
    const m = line.match(TASK_ITEM);
    // An item above the first tier heading has no tier; it is not tier 0.
    if (m && tier !== null) tiers.set(Number(m[2]), { tier, done: m[1] !== ' ' });
  }
  return tiers;
}

/**
 * Ordering written in prose next to a queue item: `#101 … (do before #80/#81)`
 * means 80 and 81 depend on 101.
 *
 * @param {{ number: number, rest: string }[]} items
 * @returns {[number, number][]} [dependent, prerequisite]
 */
export function parseProseOrdering(items) {
  const edges = [];
  for (const item of items) {
    for (const m of item.rest.matchAll(/do before ([#\d/\s,and]+)/gi)) {
      for (const n of m[1].matchAll(/#(\d+)/g)) edges.push([Number(n[1]), item.number]);
    }
  }
  return edges;
}

/** `<!-- lava-task blocked-by: [1, 2] -->`, still honoured where a body has one. */
function explicitBlockers(body) {
  const m = body && body.match(/<!--\s*lava-task\s*([\s\S]*?)-->/);
  if (!m) return [];
  const kv = m[1].match(/^\s*blocked[-_]by\s*:\s*(.+?)\s*$/m);
  if (!kv) return [];
  return [...kv[1].matchAll(/(\d+)/g)].map((x) => Number(x[1]));
}

/**
 * Build the dependency graph over a set of OPEN issues.
 *
 * Closed issues are absent from the input, and that is load-bearing: an edge to
 * a closed issue is a satisfied dependency, so it simply does not appear. The
 * graph therefore shrinks as work lands, with no checkbox bookkeeping required.
 *
 * @param {{number: number, title?: string, body?: string, labels?: {name: string}[]}[]} issues
 * @param {{ queueIssue?: number }} [opts]
 */
export function buildDag(issues, opts = {}) {
  const queueIssue = opts.queueIssue ?? MASTER_QUEUE_ISSUE;
  const byNumber = new Map(issues.map((i) => [i.number, i]));

  const index = byNumber.get(queueIssue);
  const tiers = parseTierIndex(index?.body || '');

  /** @type {Map<number, Set<number>>} issue -> what must land first */
  const blockedBy = new Map();
  /** @type {Map<number, number[]>} issue -> open children (makes it a container) */
  const children = new Map();
  const parents = new Map();

  const add = (dependent, prerequisite) => {
    if (dependent === prerequisite) return; // a self-edge would deadlock the queue
    if (!byNumber.has(prerequisite)) return; // closed: already satisfied
    if (!blockedBy.has(dependent)) blockedBy.set(dependent, new Set());
    blockedBy.get(dependent).add(prerequisite);
  };

  for (const issue of issues) {
    const items = parseTaskList(issue.body || '');
    for (const item of items) {
      if (item.done) continue;
      if (!byNumber.has(item.number)) continue;
      // A parent with open children is a container. It is blocked by them, and
      // that is what keeps epics out of the implementable queue without needing
      // to special-case the `epic` label.
      if (issue.number !== queueIssue) {
        if (!children.has(issue.number)) children.set(issue.number, []);
        children.get(issue.number).push(item.number);
        if (!parents.has(item.number)) parents.set(item.number, []);
        parents.get(item.number).push(issue.number);
        add(issue.number, item.number);
      }
    }
    if (issue.number === queueIssue) {
      for (const [dependent, prerequisite] of parseProseOrdering(items)) {
        add(dependent, prerequisite);
      }
    }
    for (const b of explicitBlockers(issue.body)) add(issue.number, b);
  }

  return {
    queueIssue,
    tiers,
    children,
    parents,
    blockedBy,
    /** @returns {number[]} unmet prerequisites, empty when implementable */
    blockers: (n) => [...(blockedBy.get(n) || [])].sort((a, b) => a - b),
    tierOf: (n) => tiers.get(n)?.tier ?? UNTIERED,
    /** Checked off in the master queue — done even if the issue is still open. */
    isDone: (n) => tiers.get(n)?.done === true,
  };
}

/**
 * Order issues the way the master queue orders them.
 * Tier first (correctness before features), then issue number for stability.
 */
export function rank(dag, issue) {
  return [dag.tierOf(issue.number), issue.number];
}

export function compareByRank(dag) {
  return (a, b) => {
    const [ta, na] = rank(dag, a);
    const [tb, nb] = rank(dag, b);
    return ta - tb || na - nb;
  };
}

/**
 * The drainable queue: implementable, not done, in priority order.
 *
 * @param {object[]} issues open issues
 * @param {{ queueIssue?: number, isReady?: (issue) => boolean, includeBlocked?: boolean }} [opts]
 *   isReady is the permission gate. Ordering is derived; permission is not.
 */
export function readyQueue(issues, opts = {}) {
  const dag = buildDag(issues, opts);
  const isReady = opts.isReady || (() => true);
  const out = [];
  for (const issue of issues) {
    if (issue.number === dag.queueIssue) continue; // the index is not a task
    if (dag.isDone(issue.number)) continue;
    if (!opts.includeBlocked && dag.blockers(issue.number).length) continue;
    if (!isReady(issue)) continue;
    out.push(issue);
  }
  return out.sort(compareByRank(dag));
}

/** Human-readable explanation for why an issue is or is not drainable. */
export function explain(dag, issue) {
  const blockers = dag.blockers(issue.number);
  return {
    issue: issue.number,
    tier: dag.tierOf(issue.number),
    done: dag.isDone(issue.number),
    blockedBy: blockers,
    children: dag.children.get(issue.number) || [],
    epics: (dag.parents.get(issue.number) || []).filter((p) => p !== dag.queueIssue),
  };
}
