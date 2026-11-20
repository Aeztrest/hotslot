import type { TxAccess } from "./access.ts";
import { accountKey, isStorageKey, keyKind, parseKey, type StateKey } from "./keys.ts";

/** tx `to` read at least one key whose latest value was produced by tx `from` (from < to). */
export interface Edge {
  from: number;
  to: number;
  keys: StateKey[];
}

/**
 * Build the read-after-write dependency graph of a block.
 *
 * Optimistic parallel execution (Monad, Block-STM) runs every tx against the pre-block state, then
 * commits in block order. Tx j's result is invalid - and j is re-executed - if a key it read was
 * changed by an earlier tx i. So j cannot finish before i: that is an edge i -> j.
 *
 * We link each read to the *most recent* earlier writer of that key, which is the value j must see.
 * Older writers are reached transitively through that writer's own edges.
 */
export function buildEdges(txs: TxAccess[]): Edge[] {
  const lastWriter = new Map<StateKey, number>();
  const fromOf = new Map(txs.map((t) => [t.index, t.from.toLowerCase()]));
  const edges: Edge[] = [];
  for (const tx of txs) {
    const byWriter = new Map<number, StateKey[]>();
    const sender = tx.from.toLowerCase();
    const ownBalance = accountKey(sender, "balance");
    for (const key of tx.reads) {
      const w = lastWriter.get(key);
      if (w === undefined) continue;
      // A sender's balance changes in each of its own txs (gas). Between two txs of the same sender that
      // edge always comes with the nonce edge, so it is nonce ordering, not a shared balance.
      if (key === ownBalance && fromOf.get(w) === sender) continue;
      const list = byWriter.get(w);
      if (list) list.push(key);
      else byWriter.set(w, [key]);
    }
    for (const [from, keys] of [...byWriter].sort((a, b) => a[0] - b[0])) {
      edges.push({ from, to: tx.index, keys: keys.sort() });
    }
    for (const key of tx.writes) lastWriter.set(key, tx.index);
  }
  return edges;
}

export interface PathResult {
  /** Number of txs on the longest dependency chain. 1 means the block is fully parallel. */
  length: number;
  /** Tx indices along that chain, in order. */
  path: number[];
  /** Chain length ending at each tx. */
  depth: number[];
  /** Σ cost along the most expensive dependency chain (equals `length` when no costs are given). */
  cost: number;
  /** Tx indices along that chain. It can differ from `path`: a short chain of heavy txs can outweigh a long light one. */
  costPath: number[];
}

/**
 * Longest path through the DAG, counted two ways in one pass:
 *   - in txs: with unlimited cores and equal-cost txs, the block needs at least `length` sequential steps,
 *     so `txCount / length` bounds its speedup;
 *   - in cost: with real tx costs, the block takes at least `cost` sequential gas, so `Σ cost / cost` bounds it.
 *
 * `ignore` drops keys from consideration; an edge disappears once all its keys are ignored. This is how
 * we ask "what if this slot were not shared?".
 */
export function longestPath(
  n: number,
  edges: Edge[],
  ignore?: (key: StateKey) => boolean,
  costs?: ArrayLike<number>,
): PathResult {
  const depth = new Array<number>(n).fill(1);
  const parent = new Int32Array(n).fill(-1);
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) weight[i] = costs ? costs[i] : 1;
  const heavy = Float64Array.from(weight);
  const heavyParent = new Int32Array(n).fill(-1);
  // Edges are sorted by `to`, and `from < to`, so a single forward pass is a topological order.
  for (const e of edges) {
    if (ignore && e.keys.every(ignore)) continue;
    if (depth[e.from] + 1 > depth[e.to]) {
      depth[e.to] = depth[e.from] + 1;
      parent[e.to] = e.from;
    }
    const c = heavy[e.from] + weight[e.to];
    if (c > heavy[e.to]) {
      heavy[e.to] = c;
      heavyParent[e.to] = e.from;
    }
  }
  if (n === 0) return { length: 0, path: [], depth, cost: 0, costPath: [] };
  let end = 0;
  let heavyEnd = 0;
  for (let i = 1; i < n; i++) {
    if (depth[i] > depth[end]) end = i;
    if (heavy[i] > heavy[heavyEnd]) heavyEnd = i;
  }
  return { length: depth[end], path: trace(parent, end), depth, cost: heavy[heavyEnd], costPath: trace(heavyParent, heavyEnd) };
}

/**
 * `longestPath` without the paths: only the two lengths. The counterfactuals (per key, per contract, the
 * greedy what-if) call this thousands of times per scan and never look at the path, so it skips the parent
 * arrays and path reconstruction.
 */
export function chainLength(
  n: number,
  edges: Edge[],
  ignore?: (key: StateKey) => boolean,
  costs?: ArrayLike<number>,
): { length: number; cost: number } {
  if (n === 0) return { length: 0, cost: 0 };
  const depth = new Int32Array(n).fill(1);
  const heavy = new Float64Array(n);
  for (let i = 0; i < n; i++) heavy[i] = costs ? costs[i] : 1;
  let length = 1;
  let cost = 0;
  for (let i = 0; i < n; i++) if (heavy[i] > cost) cost = heavy[i];
  for (const e of edges) {
    if (ignore && e.keys.every(ignore)) continue;
    const d = depth[e.from] + 1;
    if (d > depth[e.to]) {
      depth[e.to] = d;
      if (d > length) length = d;
    }
    const c = heavy[e.from] + (costs ? costs[e.to] : 1);
    if (c > heavy[e.to]) {
      heavy[e.to] = c;
      if (c > cost) cost = c;
    }
  }
  return { length, cost };
}

function trace(parent: Int32Array, end: number): number[] {
  const path: number[] = [];
  for (let i = end; i !== -1; i = parent[i]) path.push(i);
  return path.reverse();
}

export interface KeyImpact {
  key: StateKey;
  /** Edges (waits) this key participates in. */
  edges: number;
  /** Critical path length if this key alone stopped causing conflicts. */
  pathWithout: number;
  /** Same, weighted by tx cost. */
  costWithout: number;
}

export interface BlockAnalysis {
  number: number;
  timestamp: number;
  txCount: number;
  txs: { hash: string; from: string; to: string | null; system: boolean; cost: number }[];
  edges: Edge[];
  criticalPath: number[];
  /** Longest chain, all dependencies. */
  pathLength: number;
  /** Longest chain counting only storage-slot dependencies. */
  storagePathLength: number;
  /** Longest chain counting only shared native-balance dependencies (MON paid into one account by many senders). */
  balancePathLength: number;
  /** Longest chain counting only nonce order (one sender's txs). Not fixable by contract design. */
  noncePathLength: number;
  /**
   * The same four, weighted by estimated tx cost (gas). Equal-cost txs are a convenient fiction: a chain of
   * three heavy swaps can take longer than a chain of ten transfers.
   */
  pathCost: number;
  storagePathCost: number;
  balancePathCost: number;
  noncePathCost: number;
  /** Most expensive chain, all dependencies. */
  costCriticalPath: number[];
  /** Σ cost of all txs: the sequential execution time, in gas. */
  totalCost: number;
  /** The single most expensive tx: even with no conflicts the block cannot finish faster than it. */
  maxTxCost: number;
  /** Txs that had to wait on at least one earlier tx. */
  conflictedTxs: number;
  keyImpact: KeyImpact[];
  /**
   * Same counterfactual per contract: critical path if none of the contract's state - its slots and its
   * shared MON balance - conflicted, with every other dependency (other contracts, nonce order) kept.
   * Two txs usually share many slots of the same contract at once, so removing one slot rarely breaks
   * an edge. A developer fixes a contract's design, not a single slot, so this is the honest unit.
   */
  contractImpact: { address: string; pathWithout: number; costWithout: number }[];
}

/** Keys a contract's design controls: its storage and its native balance (never a nonce). */
export function contractKeys(addresses: Iterable<string>): (key: StateKey) => boolean {
  const prefixes = [...addresses].map((a) => a + ":");
  return (k) => !k.endsWith(":nonce") && prefixes.some((p) => k.startsWith(p));
}

export function analyzeBlock(number: number, timestamp: number, txs: TxAccess[]): BlockAnalysis {
  const edges = buildEdges(txs);
  const costs = txs.map((t) => t.cost);
  const path = (ignore?: (key: StateKey) => boolean) => longestPath(txs.length, edges, ignore, costs);
  const full = path();
  const storageOnly = path((k) => keyKind(k) !== "storage");
  const balanceOnly = path((k) => keyKind(k) !== "balance");
  const nonceOnly = path((k) => keyKind(k) !== "nonce");

  const edgeCount = new Map<StateKey, number>();
  for (const e of edges) for (const k of e.keys) edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);

  const keyImpact: KeyImpact[] = [...edgeCount].map(([key, count]) => {
    const without = chainLength(txs.length, edges, (k) => k === key, costs);
    return { key, edges: count, pathWithout: without.length, costWithout: without.cost };
  });
  keyImpact.sort((a, b) => a.pathWithout - b.pathWithout || b.edges - a.edges);

  const addresses = new Set([...edgeCount.keys()].filter((k) => keyKind(k) !== "nonce").map((k) => parseKey(k).address));
  // Measured on the full graph, so the gain is what the block would really get: other contracts' conflicts
  // and nonce order stay in place.
  const contractImpact = [...addresses].map((address) => {
    const without = chainLength(txs.length, edges, contractKeys([address]), costs);
    return { address, pathWithout: without.length, costWithout: without.cost };
  });
  contractImpact.sort((a, b) => a.pathWithout - b.pathWithout);

  return {
    number,
    timestamp,
    txCount: txs.length,
    txs: txs.map((t) => ({ hash: t.hash, from: t.from, to: t.to, system: t.system, cost: t.cost })),
    edges,
    criticalPath: full.path,
    pathLength: full.length,
    storagePathLength: storageOnly.length,
    balancePathLength: balanceOnly.length,
    noncePathLength: nonceOnly.length,
    pathCost: full.cost,
    storagePathCost: storageOnly.cost,
    balancePathCost: balanceOnly.cost,
    noncePathCost: nonceOnly.cost,
    costCriticalPath: full.costPath,
    totalCost: costs.reduce((a, b) => a + b, 0),
    maxTxCost: costs.reduce((a, b) => Math.max(a, b), 0),
    conflictedTxs: new Set(edges.map((e) => e.to)).size,
    keyImpact,
    contractImpact,
  };
}
