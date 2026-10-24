import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPerturbation, combineProbes, type ReplayEffects } from "../src/probe.ts";

const T = "0xaa:0x" + "0".repeat(63) + "1";
const OTHER = "0xaa:0x" + "0".repeat(63) + "2";
const fx = (writes: [string, bigint][], reverted = false): ReplayEffects => ({ reverted, writes: new Map(writes) });

test("x += 5 is an accumulator", () => {
  const r = classifyPerturbation(fx([[T, 105n]]), fx([[T, 1005n]]), T, 100n, 1000n);
  assert.equal(r.usage, "accumulator");
});

test("x = msg.sender is an overwrite: same result whatever the old value", () => {
  const r = classifyPerturbation(fx([[T, 7n]]), fx([[T, 7n]]), T, 100n, 1000n);
  assert.equal(r.usage, "overwrite");
});

test("a read that changes nothing is unused", () => {
  const r = classifyPerturbation(fx([[OTHER, 9n]]), fx([[OTHER, 9n]]), T, 100n, 1000n);
  assert.equal(r.usage, "unused");
});

test("a revert under the perturbed value is a guard", () => {
  const r = classifyPerturbation(fx([[T, 101n]]), fx([], true), T, 100n, 1000n);
  assert.equal(r.usage, "guard");
});

test("other state computed from the value is a dependency, with the affected keys", () => {
  // e.g. amountOut = f(reserve): the buyer's balance changes when the reserve does
  const r = classifyPerturbation(fx([[T, 110n], [OTHER, 50n]]), fx([[T, 1010n], [OTHER, 5n]]), T, 100n, 1000n);
  assert.equal(r.usage, "dependent");
  assert.deepEqual(r.affected, [OTHER]);
});

test("a non-additive self update (x = x * 2) is a dependency", () => {
  const r = classifyPerturbation(fx([[T, 200n]]), fx([[T, 2000n]]), T, 100n, 1000n);
  assert.equal(r.usage, "dependent");
});

test("gas payment differences are ignored", () => {
  const fee = "0xbb:balance";
  const r = classifyPerturbation(fx([[T, 105n], [fee, 1n]]), fx([[T, 1005n], [fee, 2n]]), T, 100n, 1000n, new Set([fee]));
  assert.equal(r.usage, "accumulator");
});

test("accumulator wraps around 2^256", () => {
  const max = (1n << 256n) - 1n;
  const r = classifyPerturbation(fx([[T, 4n]]), fx([[T, 3n]]), T, max - 1n, max - 2n);
  assert.equal(r.usage, "accumulator");
});

test("the most restrictive usage across samples wins", () => {
  const c = combineProbes([
    { hash: "a", usage: "accumulator" },
    { hash: "b", usage: "dependent" },
    { hash: "c", usage: null, skipped: "reverted on-chain" },
  ]);
  assert.equal(c.usage, "dependent");
  assert.equal(c.probed, 2);
});
