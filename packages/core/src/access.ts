import { estimateCost, type StorageChange } from "./cost.ts";
import { accountKey, storageKey, type StateKey } from "./keys.ts";
import type { Rpc } from "./rpc.ts";

/** Account state as returned by geth's prestateTracer. */
export interface AccountState {
  balance?: string;
  nonce?: number;
  code?: string;
  storage?: Record<string, string>;
}
export type StateMap = Record<string, AccountState>;

export interface RawTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gas: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  accessList?: { address: string; storageKeys: string[] }[];
  authorizationList?: unknown[];
}

export interface RawBlock {
  number: string;
  timestamp: string;
  miner: string;
  transactions: RawTx[];
}

/** What one transaction read and wrote. This is the input to the dependency graph. */
export interface TxAccess {
  index: number;
  hash: string;
  from: string;
  to: string | null;
  /** Monad system transactions (validator rewards etc.) are sent with gas = 0. */
  system: boolean;
  /**
   * Keys whose value this tx observed. For storage this is every slot it SLOADed *or* SSTOREd:
   * SSTORE's gas cost depends on the slot's current value (EIP-2200/2929), so a write is also a read.
   */
  reads: Set<StateKey>;
  /** Keys whose value this tx actually changed. Writes of an identical value are not counted. */
  writes: Set<StateKey>;
  /**
   * Estimated execution gas: Monad's state-access schedule applied to what the tx touched (see cost.ts).
   * A lower bound on gas used; Monad's receipts only report the gas limit.
   */
  cost: number;
  gasLimit: number;
  /** Every account the tx touched (called, read or changed), lowercase. */
  accounts?: string[];
}

/**
 * Fetch per-transaction read/write sets for a block.
 *
 * Two prestateTracer passes are needed:
 *   - default mode returns every account/slot the tx touched, with its pre-value  -> reads
 *   - diffMode returns only what changed, with pre and post values                -> writes
 */
export async function fetchBlockAccess(rpc: Rpc, blockNumber: number): Promise<{ block: RawBlock; txs: TxAccess[] }> {
  const tag = "0x" + blockNumber.toString(16);
  const [block, touched, diff] = await Promise.all([
    rpc.call<RawBlock>("eth_getBlockByNumber", [tag, true]),
    rpc.call<{ result: StateMap }[]>("debug_traceBlockByNumber", [tag, { tracer: "prestateTracer" }]),
    rpc.call<{ result: { pre: StateMap; post: StateMap } }[]>("debug_traceBlockByNumber", [
      tag,
      { tracer: "prestateTracer", tracerConfig: { diffMode: true } },
    ]),
  ]);
  if (touched.length !== block.transactions.length || diff.length !== block.transactions.length) {
    throw new Error(`block ${blockNumber}: trace count does not match tx count`);
  }
  const txs = block.transactions.map((tx, i) =>
    buildAccess(i, tx, touched[i].result, diff[i].result, block.miner.toLowerCase()),
  );
  return { block, txs };
}

export function buildAccess(
  index: number,
  tx: RawTx,
  touched: StateMap,
  diff: { pre: StateMap; post: StateMap },
  feeRecipient: string,
): TxAccess {
  const reads = new Set<StateKey>();
  const writes = new Set<StateKey>();
  const changes: StorageChange[] = [];
  const created = new Set<string>();

  for (const [addr, acc] of Object.entries(touched)) {
    for (const slot of Object.keys(acc.storage ?? {})) reads.add(storageKey(addr, slot));
  }

  for (const [addr, post] of Object.entries(diff.post)) {
    const address = addr.toLowerCase();
    // Every tx pays the fee recipient. Clients credit fees outside the parallel execution path,
    // so counting it would make every pair of transactions look dependent.
    if (address === feeRecipient) continue;
    const pre = diff.pre[addr] ?? {};
    // New code on an account that had none: created in this tx (CREATE/CREATE2) or given a 7702 delegation.
    if (post.code !== undefined && post.code !== "0x" && !pre.code) created.add(address);
    for (const [slot, value] of Object.entries(post.storage ?? {})) {
      // Some tracers omit an unchanged slot from `pre` but still list it in `post`; fall back to the
      // non-diff prestate, which always has the value the tx started from.
      const before = BigInt(pre.storage?.[slot] ?? touched[addr]?.storage?.[slot] ?? "0x0");
      const after = BigInt(value);
      if (after !== before) {
        writes.add(storageKey(addr, slot));
        changes.push({ address, slot, before, after });
      }
    }
    // Balance/nonce: a changed account was read-modify-written. We deliberately do not treat a mere
    // appearance in the touched set as a balance read (a CALL into a contract lists it there too), so
    // account-level conflicts are under-counted rather than invented.
    if (post.balance !== undefined) {
      reads.add(accountKey(addr, "balance"));
      writes.add(accountKey(addr, "balance"));
    }
    if (post.nonce !== undefined) {
      reads.add(accountKey(addr, "nonce"));
      writes.add(accountKey(addr, "nonce"));
    }
  }
  // Accounts in diff.pre but absent from post were deleted or only had fields removed; treat as changed.
  for (const addr of Object.keys(diff.pre)) {
    if (!(addr in diff.post) && addr.toLowerCase() !== feeRecipient) {
      reads.add(accountKey(addr, "balance"));
      writes.add(accountKey(addr, "balance"));
    }
  }
  // The sender's nonce always advances, even if the tracer omits it.
  reads.add(accountKey(tx.from, "nonce"));
  writes.add(accountKey(tx.from, "nonce"));

  const cost = estimateCost({
    from: tx.from,
    to: tx.to,
    input: tx.input,
    accessList: tx.accessList,
    authorizationList: tx.authorizationList,
    touched,
    changes,
    created,
    feeRecipient,
  }).total;

  return {
    index,
    hash: tx.hash,
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    system: BigInt(tx.gas) === 0n,
    reads,
    writes,
    cost,
    gasLimit: Number(BigInt(tx.gas)),
    accounts: Object.keys(touched).map((a) => a.toLowerCase()),
  };
}
