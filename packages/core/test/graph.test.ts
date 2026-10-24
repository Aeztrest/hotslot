import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBlock, buildEdges, longestPath } from "../src/graph.ts";
import { aggregate } from "../src/aggregate.ts";
import type { TxAccess } from "../src/access.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const slot = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const key = (addr: string, n: number) => `${addr}:${slot(n)}`;

function tx(index: number, from: string, reads: string[], writes: string[]): TxAccess {
  return { index, hash: `0x${index}`, from, to: A, system: false, reads: new Set([...reads, ...writes]), writes: new Set(writes) };
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
  assert.equal(b.accountPathLength, 1);
  const { summary } = aggregate([b]);
  assert.equal(summary.whatIf.length, 2, "greedy falls back to fixing the pair");
  assert.equal(summary.whatIf.at(-1)!.effectiveParallelism, 4);
});
