import { test } from "node:test";
import assert from "node:assert/strict";
import { MONAD_GAS as G, calldataGas, estimateCost, type CostInput, type StorageChange } from "../src/cost.ts";
import { buildAccess, type RawTx } from "../src/access.ts";

const FROM = "0xa11ce00000000000000000000000000000000001";
const TO = "0xc000000000000000000000000000000000000002";
const OTHER = "0xd000000000000000000000000000000000000003";
const MINER = "0xfe00000000000000000000000000000000000004";
const slot = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

/** A plain call from FROM to TO with no calldata, plus whatever state it touched. */
function input(over: Partial<CostInput> = {}): CostInput {
  return {
    from: FROM,
    to: TO,
    input: "0x",
    touched: { [FROM]: {}, [TO]: {}, [MINER]: {} },
    changes: [],
    created: new Set(),
    feeRecipient: MINER,
    ...over,
  };
}

/** TO with these slots touched, and these of them changed. */
function storage(slots: bigint[], changes: [bigint, bigint, bigint][]): Partial<CostInput> {
  return {
    touched: { [FROM]: {}, [MINER]: {}, [TO]: { storage: Object.fromEntries(slots.map((s) => [slot(s), "0x0"])) } },
    changes: changes.map(([s, before, after]): StorageChange => ({ address: TO, slot: slot(s), before, after })),
  };
}

const extra = (c: CostInput) => estimateCost(c).total - G.tx;

test("a plain transfer costs 21000: sender, recipient and fee recipient are warm", () => {
  assert.equal(estimateCost(input()).total, 21_000);
});

test("calldata: 4 per zero byte, 16 per non-zero byte", () => {
  assert.equal(calldataGas("0x"), 0);
  assert.equal(calldataGas("0x00ff0001"), 4 + 16 + 4 + 16);
  assert.equal(estimateCost(input({ input: "0xa9059cbb" })).intrinsic, 21_000 + 64);
});

test("contract creation adds 32000 and 2 per initcode word; the new contract is warm", () => {
  const created = "0xee00000000000000000000000000000000000005";
  const c = estimateCost(input({ to: null, input: "0x" + "ff".repeat(33), touched: { [FROM]: {}, [created]: {} }, created: new Set([created]) }));
  assert.equal(c.intrinsic, 21_000 + 33 * 16 + 32_000 + 2 * 2);
  assert.equal(c.accounts, 0);
});

test("every other account touched is a cold access", () => {
  assert.equal(extra(input({ touched: { [FROM]: {}, [TO]: {}, [OTHER]: {} } })), G.coldAccount);
});

// Monad docs, opcode pricing, "Cost examples (with MIP-8)".
test("SLOAD: 8100 for the first slot of a page, 100 for each other slot on it", () => {
  assert.equal(extra(input(storage([0n], []))), 8_100);
  assert.equal(extra(input(storage([0n, 1n, 127n], []))), 8_100 + 100 + 100);
  assert.equal(extra(input(storage([0n, 128n], []))), 8_100 * 2, "slot 128 is on the next page");
});

test("SSTORE of a fresh slot, first access to its page: 27,900", () => {
  assert.equal(extra(input(storage([5n], [[5n, 0n, 1n]]))), 27_900);
});

test("SSTORE of a fresh slot on a page already written: 17,100 more", () => {
  assert.equal(extra(input(storage([5n, 6n], [[5n, 0n, 1n], [6n, 0n, 1n]]))), 27_900 + 17_100);
});

test("SSTORE over a non-zero slot: 10,900 on a new page, 100 on a page already written", () => {
  assert.equal(extra(input(storage([5n], [[5n, 1n, 2n]]))), 10_900);
  assert.equal(extra(input(storage([5n, 6n], [[5n, 1n, 2n], [6n, 1n, 2n]]))), 10_900 + 100);
});

test("state growth is charged on the net new slots of a page", () => {
  // One slot created, one cleared on the same page: the page's slot count never has to exceed where it started.
  assert.equal(extra(input(storage([5n, 6n], [[5n, 0n, 1n], [6n, 1n, 0n]]))), 8_100 + 100 + 2_800);
});

test("an access list prepays its accounts and warms the pages of its keys", () => {
  const c = estimateCost(
    input({
      accessList: [{ address: OTHER, storageKeys: [slot(3n)] }],
      touched: { [FROM]: {}, [TO]: {}, [OTHER]: { storage: { [slot(3n)]: "0x0", [slot(4n)]: "0x0", [slot(200n)]: "0x0" } } },
    }),
  );
  assert.equal(c.intrinsic, 21_000 + 2_400 + 1_900);
  assert.equal(c.accounts, 0);
  // Page 0 (slots 3 and 4) is warm: 100 + 100. Slot 200 is on page 1: cold.
  assert.equal(c.storageRead, 100 + 100 + 8_100);
});

test("precompiles are warm; a call adds at least their minimum price, Monad system state adds nothing", () => {
  const ecrecover = "0x0000000000000000000000000000000000000001";
  const staking = "0x0000000000000000000000000000000000001000";
  const c = estimateCost(input({ touched: { [FROM]: {}, [TO]: {}, [ecrecover]: {}, [staking]: { storage: { [slot(1n)]: "0x1" } } } }));
  assert.equal(c.accounts, 0);
  assert.equal(c.storageRead, 0);
  assert.equal(c.precompiles, 6_000);
});

test("buildAccess wires prestate traces into the cost and keeps reads/writes as before", () => {
  const tx: RawTx = { hash: "0x1", from: FROM, to: TO, input: "0x", value: "0x0", gas: "0x30d40" };
  const touched = {
    [FROM]: { balance: "0x10", nonce: 1 },
    [TO]: { storage: { [slot(1n)]: "0x0", [slot(2n)]: "0x7" } },
    [OTHER]: { code: "0x60" },
    [MINER]: { balance: "0x0" },
  };
  const diff = {
    pre: { [FROM]: { balance: "0x10", nonce: 1 }, [TO]: { storage: { [slot(2n)]: "0x7" } }, [MINER]: { balance: "0x0" } },
    post: { [FROM]: { balance: "0x8", nonce: 2 }, [TO]: { storage: { [slot(1n)]: "0x5", [slot(2n)]: "0x7" } }, [MINER]: { balance: "0x8" } },
  };
  const a = buildAccess(0, tx, touched, diff, MINER);
  // Slot 1: 0 -> 5 (fresh). Slot 2 is listed in post with its old value: a read, not a write.
  assert.deepEqual([...a.writes].filter((k) => k.includes(":0x")), [`${TO}:${slot(1n)}`]);
  assert.equal(a.gasLimit, 200_000);
  // 21000 + cold OTHER + page 0 (8100 + 100) + page write + growth.
  assert.equal(a.cost, 21_000 + 10_100 + 8_100 + 100 + 2_800 + 17_000);
  assert.ok(a.cost <= a.gasLimit);
});

test("a 7702 delegate is not charged as a cold account (mainnet tx 0x85414a90…, limit 24,408)", () => {
  // Plain MON transfer to a delegated EOA: the trace also lists the delegate whose code ran.
  const delegate = "0x914b4bef76f8e64d3b38b1877b243f9b3507f83e";
  const c = estimateCost(
    input({ touched: { [FROM]: {}, [TO]: { code: "0xef0100" + delegate.slice(2) }, [delegate]: { code: "0x6080" }, [MINER]: {} } }),
  );
  assert.equal(c.total, 21_000);
  assert.ok(c.total <= 24_408);
});
