import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBlock, buildEdges, chainLength, longestPath } from "../src/graph.ts";
import { aggregate } from "../src/aggregate.ts";
import type { TxAccess } from "../src/access.ts";

const A = "0xaa000000000000000000000000000000000000aa";
const B = "0xbb000000000000000000000000000000000000bb";
const slot = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const key = (addr: string, n: number) => `${addr}:${slot(n)}`;

function tx(index: number, from: string, reads: string[], writes: string[], cost = 1): TxAccess {
  return {
    index, hash: `0x${index}`, from, to: A, system: false,
    reads: new Set([...reads, ...writes]), writes: new Set(writes), cost, gasLimit: cost,
  };
}

test("independent txs have no edges and full parallelism", () => {
  const txs = [tx(0, "u0", [], [key(A, 1)]), tx(1, "u1", [], [key(A, 2)]), tx(2, "u2", [], [key(A, 3)])];
  const b = analyzeBlock(1, 0, txs);
  assert.equal(b.edges.length, 0);
  assert.equal(b.pathLength, 1);
});

test("a shared counter chains every tx", () => {
  const counter = key(A, 0);
  const txs = [0, 1, 2, 3].map((i) => tx(i, `u${i}`, [], [counter]));
  const b = analyzeBlock(1, 0, txs);
  assert.deepEqual(b.criticalPath, [0, 1, 2, 3]);
  assert.equal(b.pathLength, 4);
  assert.equal(b.conflictedTxs, 3);
});

test("a read links only to the most recent writer", () => {
  const k = key(A, 0);
  const txs = [tx(0, "u0", [], [k]), tx(1, "u1", [], [k]), tx(2, "u2", [k], [])];
  const edges = buildEdges(txs);
  assert.deepEqual(
    edges.map((e) => [e.from, e.to]),
    [[0, 1], [1, 2]],
  );
});

test("read-only txs do not depend on each other", () => {
  const k = key(A, 0);
  const txs = [tx(0, "u0", [k], []), tx(1, "u1", [k], []), tx(2, "u2", [k], [])];
  assert.equal(buildEdges(txs).length, 0);
});

test("same-sender txs are ordered by nonce", () => {
  const txs = [tx(0, "alice", [], []), tx(1, "alice", [], [])];
  txs.forEach((t) => {
    t.reads.add("alice:nonce");
    t.writes.add("alice:nonce");
  });
  assert.equal(analyzeBlock(1, 0, txs).pathLength, 2);
});

test("ignoring a key removes an edge only if it was the edge's only key", () => {
  const k1 = key(A, 1);
  const k2 = key(B, 1);
  const txs = [tx(0, "u0", [], [k1, k2]), tx(1, "u1", [], [k1, k2])];
  const edges = buildEdges(txs);
  assert.equal(longestPath(2, edges, (k) => k === k1).length, 2, "still linked through k2");
  assert.equal(longestPath(2, edges, (k) => k === k1 || k === k2).length, 1);
});

test("contract counterfactual and greedy what-if handle co-hot contracts", () => {
  // Every tx touches a hot slot in A *and* in B: fixing one contract alone changes nothing.
  const txs = [0, 1, 2, 3].map((i) => tx(i, `u${i}`, [], [key(A, 0), key(B, 0)]));
  const b = analyzeBlock(1, 0, txs);
  assert.ok(b.contractImpact.every((c) => c.pathWithout === 4));
  assert.equal(b.noncePathLength, 1);
  assert.equal(b.balancePathLength, 1);
  const { summary } = aggregate([b]);
  assert.equal(summary.whatIf.length, 2, "greedy falls back to fixing the pair");
  assert.equal(summary.whatIf.at(-1)!.effectiveParallelism, 4);
});

test("without costs, the cost-weighted path is the tx count", () => {
  const counter = key(A, 0);
  const b = analyzeBlock(1, 0, [0, 1, 2].map((i) => tx(i, `u${i}`, [], [counter])));
  assert.equal(b.pathCost, 3);
  assert.equal(b.totalCost, 3);
  assert.deepEqual(b.costCriticalPath, b.criticalPath);
});

test("a short chain of heavy txs outweighs a long chain of light ones", () => {
  const light = key(A, 1);
  const heavy = key(B, 1);
  const txs = [
    tx(0, "u0", [], [light], 10),
    tx(1, "u1", [], [light], 10),
    tx(2, "u2", [], [light], 10),
    tx(3, "u3", [], [heavy], 100),
    tx(4, "u4", [], [heavy], 100),
  ];
  const b = analyzeBlock(1, 0, txs);
  assert.deepEqual(b.criticalPath, [0, 1, 2], "longest in txs");
  assert.equal(b.pathLength, 3);
  assert.deepEqual(b.costCriticalPath, [3, 4], "heaviest in gas");
  assert.equal(b.pathCost, 200);
  assert.equal(b.totalCost, 230);
  assert.equal(b.maxTxCost, 100);
});

test("cost-weighted counterfactuals drop only the ignored key's edges", () => {
  const light = key(A, 1);
  const heavy = key(B, 1);
  const txs = [tx(0, "u0", [], [light], 10), tx(1, "u1", [], [light], 10), tx(2, "u2", [], [heavy], 100), tx(3, "u3", [], [heavy], 100)];
  const b = analyzeBlock(1, 0, txs);
  const impact = new Map(b.keyImpact.map((k) => [k.key, k]));
  assert.equal(impact.get(heavy)!.costWithout, 100, "heavy pair runs in parallel, light chain is 20");
  assert.equal(impact.get(light)!.costWithout, 200, "light chain gone, heavy chain stays");
  const contracts = new Map(b.contractImpact.map((c) => [c.address, c.costWithout]));
  assert.equal(contracts.get(B), 100);
  assert.equal(contracts.get(A), 200);
});

test("gas-weighted summary divides total gas by the heaviest chains", () => {
  const heavy = key(B, 1);
  // Block 1: two 100-gas txs on one slot plus a free-standing 50-gas tx. Block 2: one 40-gas tx.
  const b1 = analyzeBlock(1, 0, [tx(0, "u0", [], [heavy], 100), tx(1, "u1", [], [heavy], 100), tx(2, "u2", [], [key(A, 9)], 50)]);
  const b2 = analyzeBlock(2, 0, [tx(0, "u0", [], [key(A, 1)], 40)]);
  const { summary, contracts } = aggregate([b1, b2]);
  assert.equal(summary.costParallelism, 290 / (200 + 40));
  assert.equal(summary.idealCostParallelism, 290 / (100 + 40));
  assert.equal(summary.storageCostParallelism, 290 / 240);
  assert.equal(summary.nonceCostParallelism, 290 / 140);
  assert.equal(contracts.find((c) => c.address === B)!.costAdded, 100);
  assert.equal(summary.whatIf.at(-1)!.costParallelism, 290 / 140);
});

test("an empty block has no path", () => {
  const b = analyzeBlock(1, 0, []);
  assert.equal(b.pathLength, 0);
  assert.equal(b.pathCost, 0);
  assert.deepEqual(b.costCriticalPath, []);
});

test("chainLength agrees with longestPath on random graphs", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(rnd() * 40);
    const keys = Array.from({ length: 6 }, (_, i) => key(i % 2 ? A : B, i));
    const txs = Array.from({ length: n }, (_, i) => {
      const touched = keys.filter(() => rnd() < 0.3);
      return tx(i, `u${i}`, touched, touched.filter(() => rnd() < 0.5), 1 + Math.floor(rnd() * 1000));
    });
    const edges = buildEdges(txs);
    const costs = txs.map((t) => t.cost);
    const ignored = keys[Math.floor(rnd() * keys.length)];
    for (const ignore of [undefined, (k: string) => k === ignored]) {
      const full = longestPath(n, edges, ignore, costs);
      assert.deepEqual(chainLength(n, edges, ignore, costs), { length: full.length, cost: full.cost });
      // The reported paths are real chains with the reported totals.
      assert.equal(full.path.length, full.length);
      assert.equal(full.costPath.reduce((s, i) => s + costs[i], 0), full.cost);
    }
  }
});

const withAccounts = (t: TxAccess, keys: string[]) => {
  for (const k of keys) {
    t.reads.add(k);
    t.writes.add(k);
  }
  return t;
};

test("a sender's own balance is nonce order, not a shared balance", () => {
  // alice sends two txs: her balance (gas) and nonce change in both.
  const txs = [0, 1].map((i) => withAccounts(tx(i, "alice", [], []), ["alice:nonce", "alice:balance"]));
  const b = analyzeBlock(1, 0, txs);
  assert.deepEqual(b.edges[0].keys, ["alice:nonce"]);
  assert.equal(b.noncePathLength, 2);
  assert.equal(b.balancePathLength, 1);
});

test("payments from different senders into one account chain them through its balance", () => {
  // u0..u3 each pay MON into vault V: V's balance changes in every tx.
  const V = "0xcc000000000000000000000000000000000000cc";
  const txs = [0, 1, 2, 3].map((i) => withAccounts(tx(i, `u${i}`, [], []), [`u${i}:nonce`, `u${i}:balance`, `${V}:balance`]));
  const b = analyzeBlock(1, 0, txs);
  assert.equal(b.pathLength, 4);
  assert.equal(b.balancePathLength, 4);
  assert.equal(b.storagePathLength, 1);
  assert.equal(b.noncePathLength, 1);
  const { summary, contracts } = aggregate([b]);
  const v = contracts.find((c) => c.address === V)!;
  assert.equal(v.balanceWaits, 3);
  assert.equal(v.stepsAdded, 3, "fixing V (its balance) removes the chain");
  assert.equal(summary.whatIf.at(-1)!.effectiveParallelism, 4);
});

test("fixing a contract's storage alone does not help while MON payments into it still chain txs", () => {
  const V = "0xcc000000000000000000000000000000000000cc";
  // Every tx bumps a counter in A and pays MON into V.
  const txs = [0, 1, 2, 3].map((i) => withAccounts(tx(i, `u${i}`, [], [key(A, 0)]), [`${V}:balance`]));
  const b = analyzeBlock(1, 0, txs);
  const impact = new Map(b.contractImpact.map((c) => [c.address, c.pathWithout]));
  assert.equal(impact.get(A), 4, "V's balance still chains them");
  assert.equal(impact.get(V), 4, "A's counter still chains them");
  const { summary } = aggregate([b]);
  assert.equal(summary.storageParallelism, 1);
  assert.equal(summary.whatIf.at(-1)!.effectiveParallelism, 4, "fixing both frees the block");
});

test("what-if keeps nonce order: one sender's txs stay sequential", () => {
  const txs = [0, 1, 2].map((i) => withAccounts(tx(i, "bot", [], [key(A, 0)]), ["bot:nonce"]));
  const { summary } = aggregate([analyzeBlock(1, 0, txs)]);
  assert.equal(summary.effectiveParallelism, 1);
  assert.equal(summary.whatIf.length, 0, "fixing A changes nothing: the bot's nonce chain remains");
});
