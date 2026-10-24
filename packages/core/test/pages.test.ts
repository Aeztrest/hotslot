import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBlock } from "../src/graph.ts";
import { comparePages, pageIndex, pageKeyOf, toPageAccess } from "../src/pages.ts";
import type { TxAccess } from "../src/access.ts";

const A = "0x00000000000000000000000000000000000000aa";
const key = (n: bigint) => `${A}:0x${n.toString(16).padStart(64, "0")}`;
const tx = (index: number, writes: string[]): TxAccess => ({
  index, hash: `0x${index}`, from: `u${index}`, to: A, system: false, reads: new Set(writes), writes: new Set(writes),
});

test("128 consecutive slots share a page", () => {
  assert.equal(pageIndex("0x0"), 0n);
  assert.equal(pageIndex("0x7f"), 0n);
  assert.equal(pageIndex("0x80"), 1n);
  assert.equal(pageKeyOf(key(5n)), pageKeyOf(key(100n)));
  assert.notEqual(pageKeyOf(key(127n)), pageKeyOf(key(128n)));
});

test("different slots on one page conflict only at page granularity (false sharing)", () => {
  // Like uint256[64] shards: each tx writes its own slot, all on page 0.
  const txs = [0, 1, 2, 3].map((i) => tx(i, [key(BigInt(2 + i))]));
  const bySlot = analyzeBlock(1, 0, txs);
  const byPage = analyzeBlock(1, 0, txs.map(toPageAccess));
  assert.equal(bySlot.pathLength, 1);
  assert.equal(byPage.pathLength, 4);
  const cmp = comparePages([bySlot], [byPage]);
  assert.equal(cmp.falseSharingEdges, 3);
  assert.equal(cmp.falseSharing[0].page, "0x0");
});

test("slots on different pages stay independent at page granularity", () => {
  const txs = [0, 1, 2].map((i) => tx(i, [key(BigInt(i) * 128n)]));
  assert.equal(analyzeBlock(1, 0, txs.map(toPageAccess)).pathLength, 1);
});
