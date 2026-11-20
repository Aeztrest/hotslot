import { chainLength, contractKeys, type BlockAnalysis } from "./graph.ts";
import { keyKind, parseKey, type KeyKind, type StateKey } from "./keys.ts";

export interface Hotspot {
  key: StateKey;
  address: string;
  slot: string;
  isStorage: boolean;
  kind: KeyKind;
  /** Times a tx had to wait on another tx because of this key. */
  waits: number;
  blocks: number;
  /**
   * Sum over blocks of (critical path) - (critical path without this key). Measured in tx-steps:
   * how many sequential execution steps this key alone added across the scanned range.
   */
  stepsAdded: number;
  /** Same, weighted by tx cost: sequential gas this key alone added across the range. */
  costAdded: number;
  /** A few (block, tx) pairs where a tx waited on this key; used for root-cause probing. */
  samples: { block: number; txIndex: number; hash: string }[];
}

export interface ContractHotspot {
  address: string;
  /** Waits involving this contract's slots or its shared MON balance. */
  waits: number;
  /** Of those, waits involving its MON balance (MON paid into it by different senders). */
  balanceWaits: number;
  /**
   * Sum over blocks of critical-path steps that disappear if none of this contract's state conflicted, with
   * every other dependency kept (0 when it is hot together with another contract).
   */
  stepsAdded: number;
  /** Same, weighted by tx cost (gas). */
  costAdded: number;
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
  /** Same, counting only shared MON balances: payments from many senders into one account. Design, too. */
  balanceParallelism: number;
  /** Same, counting only nonce order: one sender submitting several txs per block. Nothing to fix. */
  nonceParallelism: number;
  /** Σ txs / blocks: what effective parallelism would be with zero conflicts. */
  idealParallelism: number;
  conflictedShare: number;
  /**
   * The same parallelism figures with every tx weighted by its estimated cost (gas): Σ cost / Σ most
   * expensive chain. Ideal is Σ cost / Σ most expensive single tx, since a block cannot beat its heaviest tx.
   */
  costParallelism: number;
  storageCostParallelism: number;
  balanceCostParallelism: number;
  nonceCostParallelism: number;
  idealCostParallelism: number;
  /**
   * Parallelism as contracts are fixed one at a time (their slots and shared MON balance stop conflicting),
   * each step picking the contract whose fix shortens the critical paths the most. Measured on the full
   * graph: other contracts and nonce order still apply, so this is what blocks would actually get. Greedy
   * because contracts are often hot *together*: txs that share state in both A and B stay dependent until
   * both are fixed.
   */
  whatIf: { fixed: string; totalPath: number; effectiveParallelism: number; totalCost: number; costParallelism: number }[];
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
    const impact = new Map(b.keyImpact.map((k) => [k.key, k]));
    for (const [key, waiters] of waitsHere) {
      let h = byKey.get(key);
      if (!h) {
        const { address, slot, isStorage } = parseKey(key);
        h = { key, address, slot, isStorage, kind: keyKind(key), waits: 0, blocks: 0, stepsAdded: 0, costAdded: 0, samples: [] };
        byKey.set(key, h);
      }
      h.waits += waiters.length;
      h.blocks += 1;
      const without = impact.get(key);
      h.stepsAdded += b.pathLength - (without?.pathWithout ?? b.pathLength);
      h.costAdded += b.pathCost - (without?.costWithout ?? b.pathCost);
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
    if (!c) byContract.set(address, (c = { address, waits: 0, balanceWaits: 0, stepsAdded: 0, costAdded: 0, keys: 0, blocks: 0 }));
    return c;
  };
  for (const h of hotspots) if (h.isStorage) contract(h.address).keys += 1;
  for (const b of blocks) {
    for (const ci of b.contractImpact) {
      const c = contract(ci.address);
      c.stepsAdded += b.pathLength - ci.pathWithout;
      c.costAdded += b.pathCost - ci.costWithout;
      c.blocks += 1;
    }
    for (const e of b.edges) {
      const touched = new Set<string>();
      const paid = new Set<string>();
      for (const k of e.keys) {
        const kind = keyKind(k);
        if (kind === "nonce") continue;
        const a = parseKey(k).address;
        touched.add(a);
        if (kind === "balance") paid.add(a);
      }
      for (const a of touched) contract(a).waits += 1;
      for (const a of paid) contract(a).balanceWaits += 1;
    }
  }
  const contracts = [...byContract.values()].sort((a, b) => b.waits - a.waits || b.stepsAdded - a.stepsAdded);

  const txs = sum(blocks, (b) => b.txCount);
  const cost = sum(blocks, (b) => b.totalCost);
  // System precompiles (staking, reserve balance…) are not something a developer can fix; leave them out.
  const fixable = contracts.filter((c) => BigInt(c.address) >= 0x10000n);
  const whatIf = greedyFixes(blocks, fixable.slice(0, 20).map((c) => c.address), 6).map((step) => ({
    ...step,
    effectiveParallelism: txs / step.totalPath,
    costParallelism: cost / step.totalCost,
  }));

  const summary: Summary = {
    blocks: blocks.length,
    txs,
    firstBlock: Math.min(...blocks.map((b) => b.number)),
    lastBlock: Math.max(...blocks.map((b) => b.number)),
    effectiveParallelism: txs / sum(blocks, (b) => b.pathLength),
    storageParallelism: txs / sum(blocks, (b) => b.storagePathLength),
    balanceParallelism: txs / sum(blocks, (b) => b.balancePathLength),
    nonceParallelism: txs / sum(blocks, (b) => b.noncePathLength),
    idealParallelism: txs / blocks.length,
    conflictedShare: sum(blocks, (b) => b.conflictedTxs) / txs,
    costParallelism: cost / sum(blocks, (b) => b.pathCost),
    storageCostParallelism: cost / sum(blocks, (b) => b.storagePathCost),
    balanceCostParallelism: cost / sum(blocks, (b) => b.balancePathCost),
    nonceCostParallelism: cost / sum(blocks, (b) => b.noncePathCost),
    idealCostParallelism: cost / sum(blocks, (b) => b.maxTxCost),
    whatIf,
  };
  return { summary, hotspots, contracts };
}

/**
 * Contracts are picked by how many sequential steps (txs) fixing them removes, as before cost weighting
 * existed, so the order is stable; each step also reports the cost-weighted result of the same fixes.
 */
function greedyFixes(blocks: BlockAnalysis[], candidates: string[], steps: number): { fixed: string; totalPath: number; totalCost: number }[] {
  const chosen: string[] = [];
  const out: { fixed: string; totalPath: number; totalCost: number }[] = [];
  const costs = blocks.map((b) => b.txs.map((t) => t.cost));
  const pathWith = (set: string[]) => {
    const ignore = contractKeys(set);
    let path = 0;
    let cost = 0;
    blocks.forEach((b, i) => {
      const r = chainLength(b.txCount, b.edges, ignore, costs[i]);
      path += r.length;
      cost += r.cost;
    });
    return { path, cost };
  };
  let current = pathWith([]).path;
  for (let i = 0; i < steps; i++) {
    let best: { address: string; path: number; cost: number } | null = null;
    for (const c of candidates) {
      if (chosen.includes(c)) continue;
      const r = pathWith([...chosen, c]);
      if (!best || r.path < best.path) best = { address: c, ...r };
    }
    if (!best || best.path >= current) {
      // No single contract helps on its own; try the best pair (co-hot contracts).
      let pair: { a: string; b: string; path: number; cost: number } | null = null;
      for (const a of candidates) for (const b of candidates) {
        if (a >= b || chosen.includes(a) || chosen.includes(b)) continue;
        const r = pathWith([...chosen, a, b]);
        if (!pair || r.path < pair.path) pair = { a, b, ...r };
      }
      if (!pair || pair.path >= current) break;
      chosen.push(pair.a, pair.b);
      const half = pathWith(chosen.slice(0, -1));
      out.push({ fixed: pair.a, totalPath: half.path, totalCost: half.cost }, { fixed: pair.b, totalPath: pair.path, totalCost: pair.cost });
      current = pair.path;
      continue;
    }
    chosen.push(best.address);
    out.push({ fixed: best.address, totalPath: best.path, totalCost: best.cost });
    current = best.path;
  }
  return out;
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return s;
}
