import { longestPath, type BlockAnalysis } from "./graph.ts";
import { isStorageKey, parseKey, type StateKey } from "./keys.ts";

export interface Hotspot {
  key: StateKey;
  address: string;
  slot: string;
  isStorage: boolean;
  /** Times a tx had to wait on another tx because of this key. */
  waits: number;
  blocks: number;
  /**
   * Sum over blocks of (critical path) - (critical path without this key). Measured in tx-steps:
   * how many sequential execution steps this key alone added across the scanned range.
   */
  stepsAdded: number;
  /** A few (block, tx) pairs where a tx waited on this key; used for root-cause probing. */
  samples: { block: number; txIndex: number; hash: string }[];
}

export interface ContractHotspot {
  address: string;
  /** Waits involving at least one of this contract's slots. */
  waits: number;
  /** Sum over blocks of critical-path steps that disappear if none of this contract's slots conflicted. */
  stepsAdded: number;
  /** Distinct hot slots. */
  keys: number;
  blocks: number;
}

export interface Summary {
  blocks: number;
  txs: number;
  firstBlock: number;
  lastBlock: number;
  /** Σ txs / Σ critical path. The speedup unlimited cores could get over sequential execution. */
  effectiveParallelism: number;
  /** Same, counting only storage-slot dependencies: the part contract design controls. */
  storageParallelism: number;
  /** Same, counting only balance/nonce dependencies: mostly one sender submitting several txs per block. */
  accountParallelism: number;
  /** Σ txs / blocks: what effective parallelism would be with zero conflicts. */
  idealParallelism: number;
  conflictedShare: number;
  /**
   * Storage-only parallelism as contracts are fixed one at a time, each step picking the contract whose
   * fix shortens the storage critical paths the most. Greedy because contracts are often hot *together*: two
   * txs that share slots in both A and B stay dependent until both are fixed.
   */
  whatIf: { fixed: string; totalPath: number; effectiveParallelism: number }[];
}

const MAX_SAMPLES = 6;

export function aggregate(blocks: BlockAnalysis[]): { summary: Summary; hotspots: Hotspot[]; contracts: ContractHotspot[] } {
  const byKey = new Map<StateKey, Hotspot>();
  for (const b of blocks) {
    const waitsHere = new Map<StateKey, number[]>();
    for (const e of b.edges) {
      for (const k of e.keys) {
        const list = waitsHere.get(k);
        if (list) list.push(e.to);
        else waitsHere.set(k, [e.to]);
      }
    }
    const pathWithout = new Map(b.keyImpact.map((k) => [k.key, k.pathWithout]));
    for (const [key, waiters] of waitsHere) {
      let h = byKey.get(key);
      if (!h) {
        const { address, slot, isStorage } = parseKey(key);
        h = { key, address, slot, isStorage, waits: 0, blocks: 0, stepsAdded: 0, samples: [] };
        byKey.set(key, h);
      }
      h.waits += waiters.length;
      h.blocks += 1;
      h.stepsAdded += b.pathLength - (pathWithout.get(key) ?? b.pathLength);
      // Up to 3 per block, spread over the block's waiters, so samples cover several blocks when there
      // are many and still reach MAX_SAMPLES when there is one (simulation).
      const picks = [...new Set([waiters[0], waiters[waiters.length >> 1], waiters[waiters.length - 1]])];
      for (const txIndex of picks) {
        if (h.samples.length < MAX_SAMPLES && !b.txs[txIndex].system) h.samples.push({ block: b.number, txIndex, hash: b.txs[txIndex].hash });
      }
    }
  }

  // Rank slots by how often they made a tx wait. Per-slot "steps added" understates slots that are
  // always hot together with others (see contractImpact), so it is reported but not used to rank.
  const hotspots = [...byKey.values()].sort((a, b) => b.waits - a.waits || b.stepsAdded - a.stepsAdded);

  const byContract = new Map<string, ContractHotspot>();
  const contract = (address: string) => {
    let c = byContract.get(address);
    if (!c) byContract.set(address, (c = { address, waits: 0, stepsAdded: 0, keys: 0, blocks: 0 }));
    return c;
  };
  for (const h of hotspots) if (h.isStorage) contract(h.address).keys += 1;
  for (const b of blocks) {
    for (const ci of b.contractImpact) {
      const c = contract(ci.address);
      c.stepsAdded += b.storagePathLength - ci.pathWithout;
      c.blocks += 1;
    }
    for (const e of b.edges) {
      const touched = new Set(e.keys.filter(isStorageKey).map((k) => parseKey(k).address));
      for (const a of touched) contract(a).waits += 1;
    }
  }
  const contracts = [...byContract.values()].sort((a, b) => b.waits - a.waits || b.stepsAdded - a.stepsAdded);

  const txs = sum(blocks, (b) => b.txCount);
  const whatIf = greedyFixes(blocks, contracts.slice(0, 20).map((c) => c.address), 6).map((step) => ({
    ...step,
    effectiveParallelism: txs / step.totalPath,
  }));

  const summary: Summary = {
    blocks: blocks.length,
    txs,
    firstBlock: Math.min(...blocks.map((b) => b.number)),
    lastBlock: Math.max(...blocks.map((b) => b.number)),
    effectiveParallelism: txs / sum(blocks, (b) => b.pathLength),
    storageParallelism: txs / sum(blocks, (b) => b.storagePathLength),
    accountParallelism: txs / sum(blocks, (b) => b.accountPathLength),
    idealParallelism: txs / blocks.length,
    conflictedShare: sum(blocks, (b) => b.conflictedTxs) / txs,
    whatIf,
  };
  return { summary, hotspots, contracts };
}

function greedyFixes(blocks: BlockAnalysis[], candidates: string[], steps: number): { fixed: string; totalPath: number }[] {
  const chosen: string[] = [];
  const out: { fixed: string; totalPath: number }[] = [];
  const pathWith = (set: string[]) => {
    const prefixes = set.map((a) => a + ":");
    return sum(blocks, (b) => longestPath(b.txCount, b.edges, (k) => !isStorageKey(k) || prefixes.some((p) => k.startsWith(p))).length);
  };
  let current = pathWith([]);
  for (let i = 0; i < steps; i++) {
    let best: { address: string; path: number } | null = null;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      const path = pathWith([...chosen, c]);
      if (!best || path < best.path) best = { address: c, path };
    }
    if (!best || best.path >= current) {
      // No single contract helps on its own; try the best pair (co-hot contracts).
      let pair: { a: string; b: string; path: number } | null = null;
      for (const a of candidates) for (const b of candidates) {
        if (a >= b || chosen.includes(a) || chosen.includes(b)) continue;
        const path = pathWith([...chosen, a, b]);
        if (!pair || path < pair.path) pair = { a, b, path };
      }
      if (!pair || pair.path >= current) break;
      chosen.push(pair.a, pair.b);
      out.push({ fixed: pair.a, totalPath: pathWith(chosen.slice(0, -1)) }, { fixed: pair.b, totalPath: pair.path });
      current = pair.path;
      continue;
    }
    chosen.push(best.address);
    out.push({ fixed: best.address, totalPath: best.path });
    current = best.path;
  }
  return out;
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}
