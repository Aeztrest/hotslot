import type { TxAccess } from "./access.ts";
import { isStorageKey, parseKey, type StateKey } from "./keys.ts";

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
  const edges: Edge[] = [];
  for (const tx of txs) {
    const byWriter = new Map<number, StateKey[]>();
    for (const key of tx.reads) {
      const w = lastWriter.get(key);
      if (w === undefined) continue;
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
}

/**
 * Longest path through the DAG. With unlimited cores and equal-cost txs, a block cannot finish faster
 * than this many sequential steps, so `txCount / length` is an upper bound on its parallel speedup.
 *
 * `ignore` drops keys from consideration; an edge disappears once all its keys are ignored. This is how
 * we ask "what if this slot were not shared?".
 */
export function longestPath(n: number, edges: Edge[], ignore?: (key: StateKey) => boolean): PathResult {
  const depth = new Array<number>(n).fill(1);
  const parent = new Array<number>(n).fill(-1);
  // Edges are sorted by `to`, and `from < to`, so a single forward pass is a topological order.
  for (const e of edges) {
    if (ignore && e.keys.every(ignore)) continue;
    if (depth[e.from] + 1 > depth[e.to]) {
      depth[e.to] = depth[e.from] + 1;
      parent[e.to] = e.from;
    }
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (depth[i] > depth[end]) end = i;
  const path: number[] = [];
  for (let i = n === 0 ? -1 : end; i !== -1; i = parent[i]) path.push(i);
  return { length: n === 0 ? 0 : depth[end], path: path.reverse(), depth };
}

export interface KeyImpact {
  key: StateKey;
  /** Edges (waits) this key participates in. */
  edges: number;
  /** Critical path length if this key alone stopped causing conflicts. */
  pathWithout: number;
}

export interface BlockAnalysis {
  number: number;
  timestamp: number;
  txCount: number;
  txs: { hash: string; from: string; to: string | null; system: boolean }[];
  edges: Edge[];
  criticalPath: number[];
  /** Longest chain, all dependencies. */
  pathLength: number;
  /** Longest chain counting only storage-slot dependencies (ignores balance/nonce). */
  storagePathLength: number;
  /** Longest chain counting only balance/nonce dependencies (mostly one sender's txs in nonce order). */
  accountPathLength: number;
  /** Txs that had to wait on at least one earlier tx. */
  conflictedTxs: number;
  keyImpact: KeyImpact[];
  /**
   * Same counterfactual per contract, on the storage-only graph: storage critical path if none of the
   * contract's slots conflicted.
   * Two txs usually share many slots of the same contract at once, so removing one slot rarely breaks
   * an edge. A developer fixes a contract's design, not a single slot, so this is the honest unit.
   */
  contractImpact: { address: string; pathWithout: number }[];
}

export function analyzeBlock(number: number, timestamp: number, txs: TxAccess[]): BlockAnalysis {
  const edges = buildEdges(txs);
  const full = longestPath(txs.length, edges);
  const storageOnly = longestPath(txs.length, edges, (k) => !isStorageKey(k));
  const accountOnly = longestPath(txs.length, edges, (k) => isStorageKey(k));

  const edgeCount = new Map<StateKey, number>();
  for (const e of edges) for (const k of e.keys) edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);

  const keyImpact: KeyImpact[] = [...edgeCount].map(([key, count]) => ({
    key,
    edges: count,
    pathWithout: longestPath(txs.length, edges, (k) => k === key).length,
  }));
  keyImpact.sort((a, b) => a.pathWithout - b.pathWithout || b.edges - a.edges);

  const addresses = new Set([...edgeCount.keys()].filter(isStorageKey).map((k) => parseKey(k).address));
  // Measured on the storage-only graph: that is the part contract design controls.
  const contractImpact = [...addresses].map((address) => ({
    address,
    pathWithout: longestPath(txs.length, edges, (k) => !isStorageKey(k) || k.startsWith(address + ":")).length,
  }));
  contractImpact.sort((a, b) => a.pathWithout - b.pathWithout);

  return {
    number,
    timestamp,
    txCount: txs.length,
    txs: txs.map((t) => ({ hash: t.hash, from: t.from, to: t.to, system: t.system })),
    edges,
    criticalPath: full.path,
    pathLength: full.length,
    storagePathLength: storageOnly.length,
    accountPathLength: accountOnly.length,
    conflictedTxs: new Set(edges.map((e) => e.to)).size,
    keyImpact,
    contractImpact,
  };
}
